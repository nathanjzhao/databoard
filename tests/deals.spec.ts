/**
 * tests/deals.spec.ts
 *
 * The deals ledger and the leaderboard, driven end to end through the real
 * UI: multi-party uneven splits, per-participant confirmation, the deal-room
 * thread, the tier ladder (claimed / co-attested / evidence committed), the
 * decline path, solo deals, rounded public figures over exact private sums,
 * and the privacy claim extended to the two new tables.
 *
 * PRECONDITION: freshly reset + seeded DB, and a dev server on port 3948
 * started AFTER the reset (see playwright.deals.config.ts):
 *
 *   npm run reset-db && npm run seed
 *   npx next dev --port 3948
 *   npx playwright test -c playwright.deals.config.ts
 *
 * Exact leaderboard sums are re-derived here from raw deal_participants rows
 * by an INDEPENDENT reimplementation of the counting rules (not an import of
 * lib/stats.ts), so the page's rounded strings are checked against math the
 * product code did not write.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { KNOWN_BUYERS } from "../lib/buyers";

const ROOT = path.resolve(__dirname, "..");
const VERIFY_DIR = path.join(ROOT, "verify", "deals");
const EVIDENCE_DIR = path.join(ROOT, "test-results", "evidence-originals");
const DB_PATH = path.join(ROOT, "data", "app.db");

/* ------------------------------------------------------------- test data */

const USER_C = {
  realName: "Cara Voss",
  org: "Bluewater Data Collective",
  contact: "4155559001",
  username: "verifier-cove",
  password: "cove-verifies-ledgers",
};
const USER_D = {
  realName: "Dev Okafor",
  contact: "dev.okafor.test@example.org",
  username: "verifier-dune",
  password: "dune-verifies-ledgers",
};
const USER_E = {
  realName: "Elena Marsh",
  contact: "elena.marsh.test@example.org",
  username: "verifier-elm",
  password: "elm-verifies-ledgers",
};

/** Deal 1: C reports, Anthropic, $90k total, uneven $40k/$30k/$20k. */
const DEAL1 = { buyer: "Anthropic", total: "90000", myShare: "40000" };
const DEAL1_NOTE =
  "Preference-pair fill, three suppliers, split as agreed in the room.";
const ROOM_MSG_FROM_C =
  "Split is up: 40 for me, 30 for dune, 20 for elm. Answer your rows when your wires land.";

/** Deal 2 (decline path): D reports, OpenAI, $50k, D $20k / C $20k / E $10k. */
const DEAL2 = { buyer: "OpenAI", total: "50000", myShare: "20000" };

/** Deal 3: C solo, $10k, all C's. */
const DEAL3 = { buyer: "Anthropic", total: "10000", myShare: "10000" };

/** Evidence originals: hashed in the browser, never uploaded. The sentinel
 *  strings must appear NOWHERE in the DB; only their SHA-256 may. */
// Keyed by user object, not by handle: handles are assigned at signup and
// only known once signUp() has written them back.
type Evidence = { file: string; content: string; label: string };
const EVIDENCE = new Map<{ username: string }, Evidence>([
  [USER_C, {
    file: "c-original.txt",
    content:
      "EVIDENCE ORIGINAL wire credit advice unmistakable-cove-sentinel-93ab41 ref 5512\n",
    label: "bank statement line, wire credit",
  }],
  [USER_D, {
    file: "d-original.txt",
    content:
      "EVIDENCE ORIGINAL countersigned receipt unmistakable-dune-sentinel-77fe02 invoice 88\n",
    label: "signed receipt email export",
  }],
  [USER_E, {
    file: "e-original.txt",
    content:
      "EVIDENCE ORIGINAL remittance advice unmistakable-elm-sentinel-4c19d8 batch 3\n",
    label: "remittance advice PDF",
  }],
]);

function sha256HexOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/* ------------------------------------------------------- shared run state */

let context: BrowserContext;
let page: Page;
let deal1Id = "";
let deal1ThreadId = "";
let deal2Id = "";
let shotCounter = 0;

async function shot(p: Page, name: string) {
  shotCounter += 1;
  const file = `${String(shotCounter).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: path.join(VERIFY_DIR, file), fullPage: true });
}

/* ------------------------------------------------------------ UI helpers */

/** Same attested signup path the flow spec drives: demo code read off the UI. */
async function signUp(
  p: Page,
  opts: {
    realName: string;
    org?: string;
    contact: string;
    username: string;
    password: string;
  },
) {
  await p.goto("/signup");
  await expect(p.getByText("Say who you are, once")).toBeVisible();
  await p.getByLabel("Real name").fill(opts.realName);
  if (opts.org) {
    await p.getByRole("button", { name: "An organization" }).click();
    await p.getByPlaceholder("Org name").fill(opts.org);
  } else {
    await p.getByRole("button", { name: "Independent individual" }).click();
  }
  await p.getByLabel("Phone or email").fill(opts.contact);
  await p.getByRole("button", { name: "Send me a code" }).click();

  await expect(p.getByText("Type the code back")).toBeVisible();
  const demoCode = (await p.getByText(/^\d{6}$/).first().textContent())?.trim() ?? "";
  expect(demoCode).toMatch(/^\d{6}$/);
  const codeInput = p.getByLabel("Six digit code");
  await codeInput.fill(demoCode);
  await p.getByRole("button", { name: "Continue" }).click();

  await expect(p.getByText("Pick what we actually keep")).toBeVisible();
  await p.getByLabel("Password").fill(opts.password);
  await p.getByRole("button", { name: "Create account" }).click();

  // The handle is assigned by the server and shown once on the done screen.
  // Read it back into opts so everything downstream uses the real one.
  const handle =
    (await p.getByTestId("assigned-handle").textContent({ timeout: 15_000 }))
      ?.replace(/^@/, "")
      .trim() ?? "";
  expect(handle).toMatch(/^[a-z0-9][a-z0-9_-]{2,23}$/);
  opts.username = handle;
  await p.getByRole("button", { name: "Go to the board" }).click();
  await expect(p.getByText(`@${opts.username}`).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function signOut(p: Page) {
  await p.getByRole("button", { name: "Sign out" }).click();
  await p.waitForURL(/\/gate$/);
}

async function logIn(p: Page, username: string, password: string) {
  await p.goto("/login");
  await p.getByLabel("Handle").fill(username);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname === "/");
  // Full document load: the client-side push can reuse the layout payload
  // rendered logged-out on /login until router.refresh lands. The durable
  // claim is that a fresh server render sees the session.
  await p.reload();
  await expect(p.getByText(`@${username}`).first()).toBeVisible();
}

/**
 * Fills and submits /deals/new. Participants are [username, share] pairs.
 * Returns the new deal's id from the URL it lands on.
 */
async function recordDeal(
  p: Page,
  opts: {
    buyer: string;
    total: string;
    myShare: string;
    note?: string;
    participants: [string, string][];
  },
): Promise<string> {
  await p.goto("/deals/new");
  await expect(p.getByText("Say what closed, and who was in it.")).toBeVisible();
  await p.getByLabel("Buying lab").selectOption(opts.buyer);
  await p.getByLabel("Total value, USD").fill(opts.total);
  await p.getByLabel("Your share, USD").fill(opts.myShare);
  for (let i = 0; i < opts.participants.length; i++) {
    await p.getByRole("button", { name: "+ add participant" }).click();
    const [username, share] = opts.participants[i];
    await p.getByLabel("Participant username").nth(i).fill(username);
    await p.getByLabel("Participant share in USD").nth(i).fill(share);
  }
  if (opts.note) await p.getByLabel("Note, optional").fill(opts.note);
  await p.getByRole("button", { name: "Record the deal" }).click();
  // /deals/new itself matches a naive /deals/<something> pattern; wait for
  // the navigation to the new deal's page specifically.
  await p.waitForURL(/\/deals\/(?!new$)[^/]+$/);
  return p.url().split("/deals/")[1];
}

/**
 * Clicks a confirm / decline / commit button and waits for the underlying
 * POST /api/deals/[id] to answer 200, so the write is committed before the
 * test navigates. The in-page success note is ephemeral (router.refresh()
 * unmounts the card), so the response is the reliable signal.
 */
async function clickAndAwaitDealPost(p: Page, button: RegExp | string) {
  const [res] = await Promise.all([
    p.waitForResponse(
      (r) => r.request().method() === "POST" && /\/api\/deals\/[^/]+$/.test(r.url()),
    ),
    p.getByRole("button", { name: button }).click(),
  ]);
  expect(res.status(), `POST ${res.url()}`).toBe(200);
}

/** The viewer's leaderboard <tr> for a username. */
function boardRow(p: Page, username: string) {
  return p.locator("tbody tr").filter({ hasText: `@${username}` });
}

/** Asserts one leaderboard row's four displayed cells exactly. */
async function expectBoardRow(
  p: Page,
  username: string,
  cells: { collaborators: string; toOthers: string; toSelf: string; evidence: string },
) {
  const row = boardRow(p, username);
  await expect(row).toHaveCount(1);
  await expect(row.locator("td").nth(2)).toHaveText(cells.collaborators);
  await expect(row.locator("td").nth(3)).toHaveText(cells.toOthers);
  await expect(row.locator("td").nth(4)).toHaveText(cells.toSelf);
  await expect(row.locator("td").nth(5)).toHaveText(cells.evidence);
}

/**
 * No public surface may present a deal as "verified". The only sanctioned
 * appearances of the word are inside the explicit disclaimers.
 */
async function expectNoVerifiedClaim(p: Page) {
  const body = (await p.locator("body").innerText()).toLowerCase();
  const stripped = body
    .replace(/not yet independently verified/g, "")
    .replace(/independently verified/g, "")
    .replace(/does not mean verified/g, "");
  expect(stripped, `stray "verified" on ${p.url()}`).not.toContain("verified");
}

/* ----------------------- independent leaderboard math (not lib/stats.ts) */

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type PRow = {
  dealId: string;
  userId: string;
  username: string;
  role: string;
  shareUsd: number;
  status: string;
  confirmedAt: number | null;
  evidenceHash: string | null;
};

type Metrics = {
  collaborators: number;
  valueToOthersUsd: number;
  valueToSelfUsd: number;
  evidenceCommittedDeals: number;
  earliestConfirmedAt: number | null;
};

async function fetchParticipantRows(): Promise<PRow[]> {
  const client = createClient({ url: `file:${DB_PATH}` });
  const rs = await client.execute(
    `SELECT p.deal_id, p.user_id, p.role, p.share_usd, p.status,
            p.confirmed_at, p.evidence_hash, u.username
       FROM deal_participants p JOIN users u ON u.id = p.user_id`,
  );
  client.close();
  return rs.rows.map((r) => ({
    dealId: String(r.deal_id),
    userId: String(r.user_id),
    username: String(r.username),
    role: String(r.role),
    shareUsd: Number(r.share_usd),
    status: String(r.status),
    confirmedAt: r.confirmed_at == null ? null : Number(r.confirmed_at),
    evidenceHash: r.evidence_hash == null ? null : String(r.evidence_hash),
  }));
}

/** Once-per-30-days greedy pair cap, reimplemented from the spec. */
function cappedCount(timestamps: number[]): number {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let count = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const t of sorted) {
    if (t >= last + WINDOW_MS) {
      count += 1;
      last = t;
    }
  }
  return count;
}

/** The counting rules (a), (b), (c) plus tier, from raw rows. */
function computeExpectedBoard(rows: PRow[]): Map<string, Metrics> {
  const byDeal = new Map<string, PRow[]>();
  for (const r of rows) {
    const list = byDeal.get(r.dealId) ?? [];
    list.push(r);
    byDeal.set(r.dealId, list);
  }

  const metrics = new Map<string, Metrics>();
  const pairEvents = new Map<string, Map<string, number[]>>();
  const get = (username: string): Metrics => {
    let m = metrics.get(username);
    if (!m) {
      m = {
        collaborators: 0,
        valueToOthersUsd: 0,
        valueToSelfUsd: 0,
        evidenceCommittedDeals: 0,
        earliestConfirmedAt: null,
      };
      metrics.set(username, m);
    }
    return m;
  };
  const note = (m: Metrics, t: number | null) => {
    if (t == null) return;
    if (m.earliestConfirmedAt == null || t < m.earliestConfirmedAt) {
      m.earliestConfirmedAt = t;
    }
  };

  for (const dealRows of byDeal.values()) {
    const reporter = dealRows.find((r) => r.role === "reporter");
    if (!reporter) continue;
    const named = dealRows.filter((r) => r.role === "participant");
    const confirmed = named.filter((r) => r.status === "confirmed");
    const solo = named.length === 0;
    const rep = get(reporter.username);

    for (const p of confirmed) {
      rep.valueToOthersUsd += p.shareUsd;
      const mine = pairEvents.get(reporter.username) ?? new Map<string, number[]>();
      const events = mine.get(p.userId) ?? [];
      events.push(p.confirmedAt ?? 0);
      mine.set(p.userId, events);
      pairEvents.set(reporter.username, mine);
      note(rep, p.confirmedAt);
      const own = get(p.username);
      own.valueToSelfUsd += p.shareUsd;
      note(own, p.confirmedAt);
    }
    if (solo) {
      rep.valueToSelfUsd += reporter.shareUsd;
      note(rep, reporter.confirmedAt);
    } else if (confirmed.length > 0) {
      rep.valueToSelfUsd += reporter.shareUsd;
    }

    // Tier: claimed unless every named row answered and at least one
    // confirmed; evidence committed additionally needs a hash on the
    // reporter's row and every confirmed row.
    const anyPending = named.some((r) => r.status === "pending");
    const coAttested = !solo && !anyPending && confirmed.length > 0;
    const evidenceCommitted =
      coAttested &&
      Boolean(reporter.evidenceHash) &&
      confirmed.every((r) => Boolean(r.evidenceHash));
    if (evidenceCommitted) {
      for (const r of dealRows) {
        if (r.status === "confirmed") get(r.username).evidenceCommittedDeals += 1;
      }
    }
  }

  for (const [username, mine] of pairEvents) {
    const m = get(username);
    for (const events of mine.values()) m.collaborators += cappedCount(events);
  }
  return metrics;
}

/** Ranked usernames for one metric: metric desc, earliest asc, name asc. */
function expectedOrder(
  metrics: Map<string, Metrics>,
  key: "collaborators" | "valueToOthersUsd" | "valueToSelfUsd",
): string[] {
  const ranked = [...metrics.entries()].filter(
    ([, m]) =>
      m.collaborators !== 0 ||
      m.valueToOthersUsd !== 0 ||
      m.valueToSelfUsd !== 0 ||
      m.evidenceCommittedDeals !== 0,
  );
  ranked.sort(([ua, a], [ub, b]) => {
    const d = b[key] - a[key];
    if (d !== 0) return d;
    const ae = a.earliestConfirmedAt ?? Number.POSITIVE_INFINITY;
    const be = b.earliestConfirmedAt ?? Number.POSITIVE_INFINITY;
    if (ae !== be) return ae - be;
    return ua.localeCompare(ub);
  });
  return ranked.map(([u]) => u);
}

async function expectExactSums(
  who: string,
  want: Pick<Metrics, "collaborators" | "valueToOthersUsd" | "valueToSelfUsd">,
) {
  const m = computeExpectedBoard(await fetchParticipantRows()).get(who);
  expect(m, `no participant rows at all for ${who}`).toBeTruthy();
  expect(
    {
      collaborators: m!.collaborators,
      valueToOthersUsd: m!.valueToOthersUsd,
      valueToSelfUsd: m!.valueToSelfUsd,
    },
    `exact sums for ${who}`,
  ).toEqual(want);
}

/** The on-page row order (usernames, top to bottom) of the leaderboard. */
async function pageBoardOrder(p: Page): Promise<string[]> {
  const cells = await p.locator("tbody tr td:nth-child(2)").allInnerTexts();
  return cells.map((c) => {
    const m = c.match(/@([a-z0-9-]+)/);
    return m ? m[1] : c;
  });
}

/* --------------------------------------------------------------- the run */

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await fs.mkdir(VERIFY_DIR, { recursive: true });
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  for (const ev of [...EVIDENCE.values()]) {
    await fs.writeFile(path.join(EVIDENCE_DIR, ev.file), ev.content, "utf8");
  }
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("01 sign up C, D, and E through the attested signup", async () => {
  await signUp(page, USER_C);
  await shot(page, "signup-c-done");
  await signOut(page);
  await signUp(page, USER_D);
  await shot(page, "signup-d-done");
  await signOut(page);
  await signUp(page, USER_E);
  await shot(page, "signup-e-done");
  await signOut(page);
});

test("02 C records the $90k Anthropic deal with uneven D/E split; deal room exists; C's message reaches D and E", async () => {
  await logIn(page, USER_C.username, USER_C.password);

  await page.goto("/deals/new");
  await shot(page, "deal-form-empty");
  deal1Id = await recordDeal(page, {
    buyer: DEAL1.buyer,
    total: DEAL1.total,
    myShare: DEAL1.myShare,
    note: DEAL1_NOTE,
    participants: [
      [USER_D.username, "30000"],
      [USER_E.username, "20000"],
    ],
  });
  expect(deal1Id.length).toBeGreaterThan(0);

  // The full record: exact figures, claimed tier, 0 of 2 confirmed.
  await expect(page.getByText("$90,000").first()).toBeVisible();
  await expect(page.getByText("0 of 2 confirmed")).toBeVisible();
  await expect(page.getByText(`@${USER_D.username}`).first()).toBeVisible();
  await expect(page.getByText(`@${USER_E.username}`).first()).toBeVisible();
  await expect(page.getByText("$40,000").first()).toBeVisible();
  await expect(page.getByText("$30,000").first()).toBeVisible();
  await expect(page.getByText("$20,000").first()).toBeVisible();
  await shot(page, "deal1-recorded-claimed");

  // The deal room thread: C, D, E all seated, message from C.
  const roomHref = await page
    .getByRole("link", { name: "deal room thread" })
    .getAttribute("href");
  expect(roomHref).toMatch(/^\/messages\/.+/);
  deal1ThreadId = roomHref!.split("/messages/")[1];

  await page.goto(roomHref!);
  await expect(page.getByText("3 seats")).toBeVisible();
  await expect(page.getByText("deal room", { exact: true })).toBeVisible();
  await expect(page.getByText(`@${USER_D.username}`).first()).toBeVisible();
  await expect(page.getByText(`@${USER_E.username}`).first()).toBeVisible();
  await page
    .getByPlaceholder("Plain text. Enter sends, Shift+Enter for a new line.")
    .fill(ROOM_MSG_FROM_C);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("ol")).toContainText(ROOM_MSG_FROM_C);
  await shot(page, "deal1-room-c-message");

  // D sees the room and the message.
  await signOut(page);
  await logIn(page, USER_D.username, USER_D.password);
  await page.goto(`/messages/${deal1ThreadId}`);
  await expect(page.getByText("3 seats")).toBeVisible();
  await expect(page.getByText(`@${USER_C.username}`).first()).toBeVisible();
  await expect(page.getByText(`@${USER_E.username}`).first()).toBeVisible();
  await expect(page.locator("ol")).toContainText(ROOM_MSG_FROM_C);
  await shot(page, "deal1-room-as-d");

  // E too.
  await signOut(page);
  await logIn(page, USER_E.username, USER_E.password);
  await page.goto(`/messages/${deal1ThreadId}`);
  await expect(page.getByText("3 seats")).toBeVisible();
  await expect(page.locator("ol")).toContainText(ROOM_MSG_FROM_C);
  await signOut(page);
});

test("03 D confirms from the split table; 1 of 2 confirmed; leaderboard credits C and D, not E", async () => {
  await logIn(page, USER_D.username, USER_D.password);
  await page.goto("/deals");

  // The pending card: full split, exact dollars, the exact implications.
  await expect(page.getByText("Needs your confirmation")).toBeVisible();
  await expect(page.getByText("1 pending")).toBeVisible();
  await expect(page.getByText(`reported by`).first()).toBeVisible();
  await expect(page.getByText(`@${USER_C.username}`).first()).toBeVisible();
  await expect(page.getByText(`@${USER_E.username}`).first()).toBeVisible();
  await expect(page.getByText("$40,000").first()).toBeVisible();
  await expect(page.getByText("$30,000").first()).toBeVisible();
  await expect(page.getByText("$20,000").first()).toBeVisible();
  await expect(page.getByText("Confirming means")).toBeVisible();
  await expect(
    page.getByText(`@${USER_C.username} brought you into it`),
  ).toBeVisible();
  await shot(page, "deals-d-needs-confirmation");

  await clickAndAwaitDealPost(page, "Confirm my $30,000");

  await page.goto("/deals");
  await expect(page.getByText("1 of 2 confirmed")).toBeVisible();
  await shot(page, "deals-d-1-of-2");

  // Leaderboard: C has 1 collaborator, $30k to others, $40k self; D $30k
  // self; E nowhere.
  await page.goto("/leaderboard");
  await expectBoardRow(page, USER_C.username, {
    collaborators: "1",
    toOthers: "$30k",
    toSelf: "$40k",
    evidence: "0",
  });
  await expectBoardRow(page, USER_D.username, {
    collaborators: "0",
    toOthers: "<$10k",
    toSelf: "$30k",
    evidence: "0",
  });
  await expect(boardRow(page, USER_E.username)).toHaveCount(0);
  await expectNoVerifiedClaim(page);
  await shot(page, "leaderboard-after-d-confirms");

  // The exact sums underneath, from raw rows, independently recomputed.
  await expectExactSums(USER_C.username, {
    collaborators: 1,
    valueToOthersUsd: 30_000,
    valueToSelfUsd: 40_000,
  });
  await expectExactSums(USER_D.username, {
    collaborators: 0,
    valueToOthersUsd: 0,
    valueToSelfUsd: 30_000,
  });
  await signOut(page);
});

test("04 E confirms; deal co-attested; leaderboard exact and rounded; sorting by every column", async () => {
  await logIn(page, USER_E.username, USER_E.password);
  await page.goto("/deals");
  await clickAndAwaitDealPost(page, "Confirm my $20,000");

  await page.goto(`/deals/${deal1Id}`);
  await expect(page.getByText("2 of 2 confirmed")).toBeVisible();
  await expect(
    page.getByText(
      "Co-attested means the accounts agree with each other; it does not mean verified.",
    ),
  ).toBeVisible();
  await expectNoVerifiedClaim(page);
  await shot(page, "deal1-co-attested");

  await page.goto("/leaderboard");
  await expectBoardRow(page, USER_C.username, {
    collaborators: "2",
    toOthers: "$50k",
    toSelf: "$40k",
    evidence: "0",
  });
  await expectBoardRow(page, USER_D.username, {
    collaborators: "0",
    toOthers: "<$10k",
    toSelf: "$30k",
    evidence: "0",
  });
  await expectBoardRow(page, USER_E.username, {
    collaborators: "0",
    toOthers: "<$10k",
    toSelf: "$20k",
    evidence: "0",
  });
  await shot(page, "leaderboard-after-e-confirms");

  await expectExactSums(USER_C.username, {
    collaborators: 2,
    valueToOthersUsd: 50_000,
    valueToSelfUsd: 40_000,
  });
  await expectExactSums(USER_D.username, {
    collaborators: 0,
    valueToOthersUsd: 0,
    valueToSelfUsd: 30_000,
  });
  await expectExactSums(USER_E.username, {
    collaborators: 0,
    valueToOthersUsd: 0,
    valueToSelfUsd: 20_000,
  });

  // Sorting: the on-page order under every column must match the order the
  // independent math predicts (metric desc, earliest confirmation, name).
  const metrics = computeExpectedBoard(await fetchParticipantRows());
  expect(await pageBoardOrder(page)).toEqual(expectedOrder(metrics, "collaborators"));

  await page.getByRole("button", { name: /To others/ }).click();
  await expect
    .poll(() => pageBoardOrder(page))
    .toEqual(expectedOrder(metrics, "valueToOthersUsd"));
  await shot(page, "leaderboard-sort-to-others");

  await page.getByRole("button", { name: /To self/ }).click();
  await expect
    .poll(() => pageBoardOrder(page))
    .toEqual(expectedOrder(metrics, "valueToSelfUsd"));
  await shot(page, "leaderboard-sort-to-self");

  await page.getByRole("button", { name: /Brought in/ }).click();
  await expect
    .poll(() => pageBoardOrder(page))
    .toEqual(expectedOrder(metrics, "collaborators"));
  await signOut(page);
});

test("05 C, D, E each commit browser-hashed evidence; deal reaches evidence committed, never 'verified'", async () => {
  for (const user of [USER_E, USER_D, USER_C]) {
    // E is already signed out of; log each in turn (E first since we are out).
    await logIn(page, user.username, user.password);
    await page.goto(`/deals/${deal1Id}`);
    const ev = EVIDENCE.get(user)!;
    const expectedHash = sha256HexOf(ev.content);

    await expect(page.getByText("Commit evidence")).toBeVisible();
    await page
      .locator('input[type="file"]')
      .setInputFiles(path.join(EVIDENCE_DIR, ev.file));
    // WebCrypto in the page must produce the same SHA-256 node computes.
    await expect(page.getByText(expectedHash)).toBeVisible();
    if (user.username === USER_C.username) {
      await shot(page, "evidence-hash-preview-c");
    }
    await page.getByLabel("Label").fill(ev.label);
    await clickAndAwaitDealPost(page, /^Commit /);
    await signOut(page);
  }

  // All three hashes on file: the deal is evidence committed now.
  await logIn(page, USER_C.username, USER_C.password);
  await page.goto(`/deals/${deal1Id}`);
  await expect(page.getByText("evidence committed").first()).toBeVisible();
  await expect(
    page.getByText("The platform holds the fingerprints, never the documents.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("not yet independently verified").first()).toBeVisible();
  await expectNoVerifiedClaim(page);
  await shot(page, "deal1-evidence-committed");

  // Leaderboard badge column ticks to 1 for all three.
  await page.goto("/leaderboard");
  await expectBoardRow(page, USER_C.username, {
    collaborators: "2",
    toOthers: "$50k",
    toSelf: "$40k",
    evidence: "1",
  });
  await expectBoardRow(page, USER_D.username, {
    collaborators: "0",
    toOthers: "<$10k",
    toSelf: "$30k",
    evidence: "1",
  });
  await expectBoardRow(page, USER_E.username, {
    collaborators: "0",
    toOthers: "<$10k",
    toSelf: "$20k",
    evidence: "1",
  });
  await expectNoVerifiedClaim(page);
  await shot(page, "leaderboard-evidence-badges");
  await signOut(page);
});

test("06 decline path: D reports naming C and E; C declines, E confirms; only E's share credits D; C untouched", async () => {
  await logIn(page, USER_D.username, USER_D.password);
  deal2Id = await recordDeal(page, {
    buyer: DEAL2.buyer,
    total: DEAL2.total,
    myShare: DEAL2.myShare,
    participants: [
      [USER_C.username, "20000"],
      [USER_E.username, "10000"],
    ],
  });
  await shot(page, "deal2-recorded-by-d");
  await signOut(page);

  // C declines their $20k row.
  await logIn(page, USER_C.username, USER_C.password);
  await page.goto("/deals");
  await expect(page.getByText("Needs your confirmation")).toBeVisible();
  await expect(page.getByText(`@${USER_D.username} brought you into it`)).toBeVisible();
  await clickAndAwaitDealPost(page, "Decline");
  await page.goto(`/deals/${deal2Id}`);
  await expect(page.getByText("declined", { exact: true }).first()).toBeVisible();
  await shot(page, "deal2-c-declined");
  await signOut(page);

  // E confirms their $10k row.
  await logIn(page, USER_E.username, USER_E.password);
  await page.goto("/deals");
  await clickAndAwaitDealPost(page, "Confirm my $10,000");

  // Declined row never counts; the other confirmation stands: co-attested.
  await page.goto(`/deals/${deal2Id}`);
  await expect(page.getByText("1 of 2 confirmed")).toBeVisible();
  await expect(
    page.getByText(`@${USER_C.username} declined; their row counts nowhere`),
  ).toBeVisible();
  await shot(page, "deal2-e-confirmed-c-declined");

  // D credits 1 collaborator (E) and only E's $10k; C's figures unchanged.
  await page.goto("/leaderboard");
  await expectBoardRow(page, USER_D.username, {
    collaborators: "1",
    toOthers: "$10k",
    toSelf: "$50k",
    evidence: "1",
  });
  await expectBoardRow(page, USER_C.username, {
    collaborators: "2",
    toOthers: "$50k",
    toSelf: "$40k",
    evidence: "1",
  });
  await expectBoardRow(page, USER_E.username, {
    collaborators: "0",
    toOthers: "<$10k",
    toSelf: "$30k",
    evidence: "1",
  });
  await shot(page, "leaderboard-after-decline-path");

  await expectExactSums(USER_D.username, {
    collaborators: 1,
    valueToOthersUsd: 10_000,
    valueToSelfUsd: 50_000,
  });
  await expectExactSums(USER_C.username, {
    collaborators: 2,
    valueToOthersUsd: 50_000,
    valueToSelfUsd: 40_000,
  });
  await expectExactSums(USER_E.username, {
    collaborators: 0,
    valueToOthersUsd: 0,
    valueToSelfUsd: 30_000,
  });
  await signOut(page);
});

test("07 a $10k solo deal by C bumps only C's self value, to $50k displayed", async () => {
  await logIn(page, USER_C.username, USER_C.password);
  const soloId = await recordDeal(page, {
    buyer: DEAL3.buyer,
    total: DEAL3.total,
    myShare: DEAL3.myShare,
    participants: [],
  });
  expect(soloId.length).toBeGreaterThan(0);
  await expect(page.getByText("solo deal").first()).toBeVisible();
  await expect(page.getByText("claimed").first()).toBeVisible();
  await shot(page, "deal3-solo-claimed");

  await page.goto("/leaderboard");
  await expectBoardRow(page, USER_C.username, {
    collaborators: "2",
    toOthers: "$50k",
    toSelf: "$50k",
    evidence: "1",
  });
  // Nobody else moved.
  await expectBoardRow(page, USER_D.username, {
    collaborators: "1",
    toOthers: "$10k",
    toSelf: "$50k",
    evidence: "1",
  });
  await expectBoardRow(page, USER_E.username, {
    collaborators: "0",
    toOthers: "<$10k",
    toSelf: "$30k",
    evidence: "1",
  });
  await shot(page, "leaderboard-final");

  await expectExactSums(USER_C.username, {
    collaborators: 2,
    valueToOthersUsd: 50_000,
    valueToSelfUsd: 50_000,
  });
  await signOut(page);
});

test("08 PRIVACY: no PII, no buyer name, no evidence document content anywhere in the DB; only hashes", async () => {
  const literals = [
    USER_C.contact,
    "1" + USER_C.contact,
    USER_C.realName,
    "caravoss",
    USER_C.org,
    "bluewaterdatacollective",
    USER_D.contact,
    "dev.okafor.test",
    USER_D.realName,
    "devokafor",
    USER_E.contact,
    "elena.marsh.test",
    USER_E.realName,
    "elenamarsh",
    "example.org",
    ...KNOWN_BUYERS,
    ...KNOWN_BUYERS.map((b) => b.toLowerCase().replace(/[^a-z0-9]+/g, "")),
    // The evidence ORIGINALS: hashed in the browser, never uploaded. Their
    // sentinel substrings must not exist in any row or any raw byte.
    ...[...EVIDENCE.values()].map((e) => e.content.trim()),
    "unmistakable-cove-sentinel-93ab41",
    "unmistakable-dune-sentinel-77fe02",
    "unmistakable-elm-sentinel-4c19d8",
  ];
  const forbidden = [...new Set(literals.map((s) => s.toLowerCase()))];

  // Same carve-out as the flow spec: random base64url ids can contain any
  // short letter run by coin flip, so 3-to-5-char patterns are skipped in
  // opaque values only.
  const OPAQUE = /^[A-Za-z0-9_-]{16,}$/;

  const client = createClient({ url: `file:${DB_PATH}` });
  const tablesRs = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const tables = tablesRs.rows.map((r) => String(r.name));
  expect(tables.sort()).toEqual([
    "asks",
    "collab_requests",
    "deal_participants",
    "deals",
    "messages",
    "sessions",
    "thread_keys",
    "thread_participants",
    "threads",
    "user_e2ee_keys",
    "users",
  ]);

  const violations: string[] = [];
  const rowCounts: Record<string, number> = {};
  for (const table of tables) {
    const rs = await client.execute(`SELECT * FROM "${table}"`);
    rowCounts[table] = rs.rows.length;
    for (const row of rs.rows) {
      for (const col of rs.columns) {
        const raw = (row as Record<string, unknown>)[col];
        if (raw == null) continue;
        const value = String(raw);
        const lower = value.toLowerCase();
        const opaque = OPAQUE.test(value);
        for (const pat of forbidden) {
          if (opaque && pat.length < 6) continue;
          if (lower.includes(pat)) {
            violations.push(`${table}.${col} contains "${pat}": ${value.slice(0, 100)}`);
          }
        }
      }
    }
  }

  // What MAY exist: the three evidence hashes, exactly, on deal 1's rows.
  const hashesRs = await client.execute({
    sql: `SELECT p.evidence_hash, p.evidence_label, u.username
            FROM deal_participants p JOIN users u ON u.id = p.user_id
           WHERE p.deal_id = ? ORDER BY u.username`,
    args: [deal1Id],
  });
  const byUser = new Map(
    hashesRs.rows.map((r) => [String(r.username), String(r.evidence_hash ?? "")]),
  );
  for (const user of [USER_C, USER_D, USER_E]) {
    const ev = EVIDENCE.get(user)!;
    expect(byUser.get(user.username), `evidence hash for ${user.username}`).toBe(
      sha256HexOf(ev.content),
    );
  }

  // Buyer blinding on deals: the token is a v2 OPRF token ("v2:" + 128 hex,
  // RFC 9497 VOPRF output), identical to the token the seeded Anthropic ask
  // minted in a different process, and the name itself appears nowhere
  // (asserted by the scan above).
  const dealRs = await client.execute({
    sql: `SELECT buyer_token FROM deals WHERE id = ?`,
    args: [deal1Id],
  });
  const dealToken = String(dealRs.rows[0]?.buyer_token ?? "");
  expect(dealToken).toMatch(/^v2:[0-9a-f]{128}$/);
  const askRs = await client.execute({
    sql: `SELECT buyer_token FROM asks WHERE title = ?`,
    args: ["Contested-topic preference pairs, expert-rated"],
  });
  expect(String(askRs.rows[0]?.buyer_token)).toBe(dealToken);
  client.close();

  // The scan must have chewed real data: 6 seed users + C/D/E, 5 seed deals
  // + 3 recorded here, and the participant rows underneath them.
  expect(rowCounts.users).toBeGreaterThanOrEqual(9);
  expect(rowCounts.deals).toBeGreaterThanOrEqual(8);
  expect(rowCounts.deal_participants).toBeGreaterThanOrEqual(20);
  expect(rowCounts.threads).toBeGreaterThanOrEqual(6);
  expect(rowCounts.messages).toBeGreaterThanOrEqual(8);

  expect(violations, "PII or document content found in the database").toEqual([]);

  // Raw bytes too, WAL sidecars included, for patterns long enough to be
  // unambiguous.
  const rawForbidden = forbidden.filter((p) => p.length >= 6);
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = DB_PATH + suffix;
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch {
      continue;
    }
    const haystack = bytes.toString("latin1").toLowerCase();
    for (const pat of rawForbidden) {
      expect(
        haystack.includes(pat),
        `raw bytes of ${path.basename(file)} contain "${pat}"`,
      ).toBe(false);
    }
  }
});
