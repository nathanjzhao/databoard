/**
 * tests/flows.spec.ts
 *
 * Verifier suite for the five new flow features, driven end to end through
 * the real UI against seed data:
 *
 *   1. supplier pooling ("Asks you offered on" + the shared-ask vouch on
 *      POST /api/threads/direct, including the 403 for outsiders),
 *   2. deal -> ask feedback (confirmed-deal note for viewers, owner banner,
 *      the ask_activity refresh at settle time),
 *   3. the 7-day auto-close sweep (pre-aged seed ask closes as auto_stale,
 *      fresh asks survive, "Still ongoing" resets the clock, and the guard
 *      is made to fail on purpose by aging a fresh ask),
 *   4. stated exclusivity terms (required at post time, chips on board /
 *      ask / matches combined view, "terms unspecified" for legacy asks),
 *   5. similar links (the compose hint via GET /api/asks/similar, the
 *      Related section, and a network scan proving no buyer name ever
 *      crossed the wire to the similar endpoint or anywhere else).
 *
 * Ends with the full-database privacy scan over every table, new ones
 * included.
 *
 * PRECONDITION: same as flow.spec.ts. Fresh reset + seed, dev server
 * started after the reset (playwright.config.ts starts/reuses PW_PORT).
 * Serial; one worker; the tests share accounts and board state.
 */

import { test, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createClient, type InValue } from "@libsql/client";
import { promises as fs } from "node:fs";
import path from "node:path";
import { KNOWN_BUYERS } from "../lib/buyers";
import { unusedInviteCode } from "./invite-codes";

const ROOT = path.resolve(__dirname, "..");
const VERIFY_DIR = path.join(ROOT, "verify", "flows");
const DB_PATH = path.join(ROOT, "data", "app.db");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEMO_PASSWORD = "demo-demo-demo";

/* ------------------------------------------------------------- test data */

const USER_P = {
  realName: "Pia Ortega",
  org: "Sable Bench Labs",
  contact: "pia.ortega.test@example.net",
  username: "verifier-pool",
  password: "pool-verifies-flows",
};
const USER_Q = {
  realName: "Quinn Baker",
  contact: "quinn.baker.test@example.net",
  username: "verifier-quay",
  password: "quay-verifies-flows",
};
const USER_R = {
  realName: "Rowan Slate",
  contact: "4155559317",
  username: "verifier-ridge",
  password: "ridge-verifies-flows",
};

/** Seeded asks this suite leans on, addressed by their exact titles. */
const POOL_ASK = "Non-English clinical reasoning evals, physician-written"; // cold-copy, open
const FEEDBACK_ASK = "Factory-floor multicam video with synchronized PLC logs"; // midnight-audit, open, affirmed 6d ago
const PREAGED_ASK = "Weather-station sensor logs with calibration certificates"; // paper-trail, 10d stale
const FRESH_ASK = "Call-center audio with consented emotion labels"; // cold-copy, open, 0d
const GUARD_ASK = "Seed trajectories for a household-robotics RL environment"; // quiet-ledger, partial, 2d
const EXCLUSIVE_ASK = "Contested-topic preference pairs, expert-rated"; // granite-fox, Anthropic, exclusive, open
const LEGACY_TERMS_ASK = "Adversarial jailbreak conversations, human-authored"; // paper-trail, closed, no terms row

const P_NOTE = "Holding physician-written vignettes in Portuguese, roughly a third of the item count.";
const Q_NOTE = "Arabic items with distractor rationales, original, never published.";
const STILL_ONGOING_NOTE = "Batch two of the calls cleared consent review this week. Still buying.";

const NEW_ASK = {
  title: "Rubric-graded eval transcripts for safety cases",
  category: "Eval / benchmark data",
  buyer: "Anthropic",
  description:
    "Transcripts graded against published rubrics, with grader disagreement kept, not resolved away.",
};

/* ------------------------------------------------------- shared run state */

let context: BrowserContext;
let page: Page;
let poolAskId = "";
let feedbackAskId = "";
let preagedAskId = "";
let freshAskId = "";
let guardAskId = "";
let legacyTermsAskId = "";
let newAskId = "";
let dealId = "";
let shotCounter = 0;

async function shot(p: Page, name: string) {
  shotCounter += 1;
  const file = `${String(shotCounter).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: path.join(VERIFY_DIR, file), fullPage: true });
}

/* --------------------------------------------------------------- DB access */

async function dbQuery(sql: string, args: InValue[] = []) {
  const client = createClient({ url: `file:${DB_PATH}` });
  try {
    return await client.execute({ sql, args });
  } finally {
    client.close();
  }
}

async function askIdByTitle(title: string): Promise<string> {
  const rs = await dbQuery(`SELECT id FROM asks WHERE title = ?`, [title]);
  const id = String(rs.rows[0]?.id ?? "");
  expect(id, `seeded ask "${title}" exists`).not.toBe("");
  return id;
}

async function askStatus(askId: string): Promise<string> {
  const rs = await dbQuery(`SELECT status FROM asks WHERE id = ?`, [askId]);
  return String(rs.rows[0]?.status ?? "");
}

async function affirmedAt(askId: string): Promise<number> {
  const rs = await dbQuery(
    `SELECT affirmed_at FROM ask_activity WHERE ask_id = ?`,
    [askId],
  );
  return Number(rs.rows[0]?.affirmed_at ?? 0);
}

/* ------------------------------------------------------------ UI helpers */

/** Same attested signup path the other specs drive; handle written back. */
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
  // Invite-only: a seeded member's unused code, read from the local DB.
  await p.getByLabel("Invite code").fill(await unusedInviteCode());
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
  await p.getByLabel("Six digit code").fill(demoCode);
  await p.getByRole("button", { name: "Continue" }).click();

  await expect(p.getByText("Pick what we actually keep")).toBeVisible();
  await p.getByLabel("Password").fill(opts.password);
  await p.getByRole("button", { name: "Create account" }).click();

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
  // Full document load: the durable claim is that a fresh server render
  // sees the session (same reasoning as deals.spec.ts).
  await p.reload();
  await expect(p.getByText(`@${username}`).first()).toBeVisible();
}

/** Request collab on an ask through its page, note and all. */
async function requestCollab(p: Page, askId: string, note: string) {
  await p.goto(`/ask/${askId}`);
  await p.getByLabel("Note to the poster, optional").fill(note);
  await p.getByRole("button", { name: "Request to collaborate" }).click();
  await expect(p.getByText("Request sent", { exact: true })).toBeVisible();
}

/** Clicks a deal confirm button and waits for the POST to land. */
async function clickAndAwaitDealPost(p: Page, button: RegExp | string) {
  const [res] = await Promise.all([
    p.waitForResponse(
      (r) => r.request().method() === "POST" && /\/api\/deals\/[^/]+$/.test(r.url()),
    ),
    p.getByRole("button", { name: button }).click(),
  ]);
  expect(res.status(), `POST ${res.url()}`).toBe(200);
}

/* --------------------------------------------------------------- the run */

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await fs.mkdir(VERIFY_DIR, { recursive: true });
  context = await browser.newContext();
  page = await context.newPage();
  poolAskId = await askIdByTitle(POOL_ASK);
  feedbackAskId = await askIdByTitle(FEEDBACK_ASK);
  preagedAskId = await askIdByTitle(PREAGED_ASK);
  freshAskId = await askIdByTitle(FRESH_ASK);
  guardAskId = await askIdByTitle(GUARD_ASK);
  legacyTermsAskId = await askIdByTitle(LEGACY_TERMS_ASK);
});

test.afterAll(async () => {
  await context?.close();
});

test("01 sign up P, Q, and R", async () => {
  await signUp(page, USER_P);
  await signOut(page);
  await signUp(page, USER_Q);
  await signOut(page);
  await signUp(page, USER_R);
  await signOut(page);
});

test("02 POOLING: P and Q offer on the same ask, see each other on /matches, and P opens a pooling thread with Q", async () => {
  await logIn(page, USER_P.username, USER_P.password);
  await requestCollab(page, poolAskId, P_NOTE);
  await signOut(page);

  await logIn(page, USER_Q.username, USER_Q.password);
  await requestCollab(page, poolAskId, Q_NOTE);

  // Q sees P under "Asks you offered on": the offered card links the ask
  // and lists P's live offer with the pooling door.
  await page.goto("/matches");
  await expect(
    page.getByRole("heading", { name: "Asks you offered on" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: POOL_ASK })).toBeVisible();
  const qRow = page
    .locator("li")
    .filter({ hasText: `@${USER_P.username}` })
    .filter({ has: page.getByRole("button", { name: "Propose pooling" }) });
  await expect(qRow).toHaveCount(1);
  await expect(qRow.getByText("offer pending")).toBeVisible();
  await shot(page, "matches-q-sees-p");
  await signOut(page);

  // P sees Q, and the button opens a two-person thread.
  await logIn(page, USER_P.username, USER_P.password);
  await page.goto("/matches");
  await expect(page.getByRole("link", { name: POOL_ASK })).toBeVisible();
  const pRow = page
    .locator("li")
    .filter({ hasText: `@${USER_Q.username}` })
    .filter({ has: page.getByRole("button", { name: "Propose pooling" }) });
  await expect(pRow).toHaveCount(1);
  await shot(page, "matches-p-sees-q");

  await pRow.getByRole("button", { name: "Propose pooling" }).click();
  await page.waitForURL(/\/messages\/[^/]+$/);
  await expect(page.getByText(POOL_ASK).first()).toBeVisible();
  await expect(page.getByText(`@${USER_Q.username}`).first()).toBeVisible();
  await shot(page, "pooling-thread-p-q");

  // Leave the polling thread view, then out.
  await page.goto("/");
  await signOut(page);
});

test("03 POOLING GUARD: R, with no offer on the ask, gets a 403 for P and Q; the poster stays reachable; /matches empty states are honest", async () => {
  await logIn(page, USER_R.username, USER_R.password);

  // Honest empty states: no offers is not the same message as no asks.
  await page.goto("/matches");
  await expect(page.getByText("You have no live offers out.")).toBeVisible();
  await expect(page.getByText("You have not posted an ask")).toBeVisible();
  await shot(page, "matches-r-empty-states");

  // The shared-ask vouch is mutual: one-sided (R has no live request on the
  // ask) means 403, toward either supplier.
  for (const target of [USER_Q.username, USER_P.username]) {
    const res = await page.request.post("/api/threads/direct", {
      data: { askId: poolAskId, username: target },
    });
    expect(res.status(), `direct thread R -> @${target}`).toBe(403);
  }

  // Not a blanket refusal: the ask still vouches for its own poster.
  const posterRes = await page.request.post("/api/threads/direct", {
    data: { askId: poolAskId, username: "cold-copy" },
  });
  expect(posterRes.status()).toBe(200);
  const posterBody = (await posterRes.json()) as { threadId?: string };
  expect(posterBody.threadId ?? "").not.toBe("");

  await signOut(page);
});

test("04 FEEDBACK: a confirmed deal linked to an ask surfaces on the ask page and refreshes ask_activity", async () => {
  const beforeAffirm = await affirmedAt(feedbackAskId);
  expect(beforeAffirm).toBeGreaterThan(0);
  expect(beforeAffirm).toBeLessThan(Date.now() - 5 * DAY_MS); // seeded 6d stale

  // P records a deal linked to the seeded ask, naming Q.
  await logIn(page, USER_P.username, USER_P.password);
  await page.goto("/deals/new");
  await expect(page.getByText("Say what closed, and who was in it.")).toBeVisible();
  await page.getByLabel("Buying lab").selectOption("Nvidia");
  await page.getByLabel("Linked ask, optional").selectOption(feedbackAskId);
  await page.getByLabel("Total value, USD").fill("50000");
  await page.getByLabel("Your share, USD").fill("30000");
  await page.getByRole("button", { name: "+ add participant" }).click();
  await page.getByLabel("Participant handle").first().fill(USER_Q.username);
  await page.getByLabel("Participant share in USD").first().fill("20000");
  await page.getByRole("button", { name: "Record the deal" }).click();
  await page.waitForURL(/\/deals\/(?!new$)[^/]+$/);
  dealId = page.url().split("/deals/")[1];
  await expect(page.getByText("0 of 1 confirmed")).toBeVisible();
  await shot(page, "deal-recorded-linked");
  await signOut(page);

  // Q confirms; the deal settles at co-attested.
  await logIn(page, USER_Q.username, USER_Q.password);
  await page.goto("/deals");
  await expect(page.getByText("Needs your confirmation")).toBeVisible();
  await clickAndAwaitDealPost(page, "Confirm my $20,000");
  await signOut(page);

  // The settle wrote the feedback: co-attested count 1, activity refreshed.
  const countRs = await dbQuery(
    `SELECT COUNT(*) AS n FROM deals d
      WHERE d.ask_id = ?
        AND EXISTS (SELECT 1 FROM deal_participants p
                     WHERE p.deal_id = d.id AND p.role = 'participant'
                       AND p.status = 'confirmed')
        AND NOT EXISTS (SELECT 1 FROM deal_participants p
                         WHERE p.deal_id = d.id AND p.role = 'participant'
                           AND p.status = 'pending')`,
    [feedbackAskId],
  );
  expect(Number(countRs.rows[0]?.n)).toBe(1);
  const afterAffirm = await affirmedAt(feedbackAskId);
  expect(afterAffirm).toBeGreaterThan(Date.now() - 10 * 60 * 1000);

  // A third party sees the count and never the amounts.
  await logIn(page, USER_R.username, USER_R.password);
  await page.goto(`/ask/${feedbackAskId}`);
  await expect(
    page.getByText("confirmed deal references this ask.").first(),
  ).toBeVisible();
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("$50,000");
  expect(bodyText).not.toContain("$30,000");
  expect(bodyText).not.toContain("$20,000");
  expect(bodyText).not.toContain("update the meter or close it"); // owner banner is the owner's
  await shot(page, "ask-third-party-deal-note");
  await signOut(page);

  // The owner gets the banner with the door to their controls.
  await logIn(page, "midnight-audit", DEMO_PASSWORD);
  await page.goto(`/ask/${feedbackAskId}`);
  await expect(
    page.getByText("A confirmed deal references this ask."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "update the meter or close it" }),
  ).toBeVisible();
  await shot(page, "ask-owner-deal-banner");
  await signOut(page);
});

test("05 AUTO-CLOSE: the pre-aged seed ask closes as auto_stale; fresh asks survive; the page says so and still offers reach-out", async () => {
  expect(await askStatus(preagedAskId)).toBe("open");
  const closuresBefore = await dbQuery(
    `SELECT 1 FROM ask_closures WHERE ask_id = ?`,
    [preagedAskId],
  );
  expect(closuresBefore.rows.length).toBe(0);

  const res = await page.request.get("/api/cron/autoclose");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { closed: number };
  expect(body.closed).toBeGreaterThanOrEqual(1);

  expect(await askStatus(preagedAskId)).toBe("closed");
  const closure = await dbQuery(
    `SELECT reason FROM ask_closures WHERE ask_id = ?`,
    [preagedAskId],
  );
  expect(String(closure.rows[0]?.reason)).toBe("auto_stale");

  // Fresh asks are untouched, including ones affirmed after an old posting.
  expect(await askStatus(freshAskId)).toBe("open");
  expect(await askStatus(guardAskId)).toBe("partial");
  expect(await askStatus(await askIdByTitle("Merged-PR triplets from private monorepos"))).toBe("partial");

  // The closed ask wears the reason and keeps the reach-out affordance.
  await logIn(page, USER_R.username, USER_R.password);
  await page.goto(`/ask/${preagedAskId}`);
  await expect(
    page.getByText("Closed automatically after 7 days without an update"),
  ).toBeVisible();
  await expect(page.getByText("Closed, poster still here")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reach out to the poster" }),
  ).toBeVisible();
  await shot(page, "ask-auto-closed-notice");
  await signOut(page);
});

test("06 AUTO-CLOSE: the owner's Still ongoing button resets the clock, so an aged-then-affirmed ask survives the sweep", async () => {
  // Age the fresh ask past the 7-day clock by direct DB update.
  await dbQuery(`UPDATE ask_activity SET affirmed_at = ? WHERE ask_id = ?`, [
    Date.now() - 8 * DAY_MS,
    freshAskId,
  ]);

  await logIn(page, "cold-copy", DEMO_PASSWORD);
  await page.goto(`/ask/${freshAskId}`);
  // Under 3 days remaining (here: overdue), the countdown shows.
  await expect(
    page.getByText("auto-closes on the next sweep unless updated"),
  ).toBeVisible();
  await shot(page, "owner-countdown-overdue");

  await page.getByLabel("Update note").fill(STILL_ONGOING_NOTE);
  const [patchRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PATCH" && /\/api\/asks\/[^/]+$/.test(r.url()),
    ),
    page.getByRole("button", { name: "Still ongoing" }).click(),
  ]);
  expect(patchRes.status()).toBe(200);

  const affirmed = await affirmedAt(freshAskId);
  expect(affirmed).toBeGreaterThan(Date.now() - 10 * 60 * 1000);
  const noteRs = await dbQuery(`SELECT note FROM ask_activity WHERE ask_id = ?`, [
    freshAskId,
  ]);
  expect(String(noteRs.rows[0]?.note)).toBe(STILL_ONGOING_NOTE);

  // The sweep runs and the affirmed ask survives.
  const res = await page.request.get("/api/cron/autoclose");
  expect(res.status()).toBe(200);
  expect(await askStatus(freshAskId)).toBe("open");

  // The note shows on the ask page as the last update.
  await page.goto(`/ask/${freshAskId}`);
  await expect(page.getByText("Last update")).toBeVisible();
  await expect(page.getByText(STILL_ONGOING_NOTE)).toBeVisible();
  await shot(page, "ask-last-update-note");
  await signOut(page);
});

test("07 AUTO-CLOSE GUARD SENSITIVITY: an artificially aged fresh ask IS closed by the sweep", async () => {
  const savedAffirm = await affirmedAt(guardAskId);
  await dbQuery(`UPDATE ask_activity SET affirmed_at = ? WHERE ask_id = ?`, [
    Date.now() - 8 * DAY_MS,
    guardAskId,
  ]);

  const res = await page.request.get("/api/cron/autoclose");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { closed: number };
  expect(body.closed).toBeGreaterThanOrEqual(1);
  expect(await askStatus(guardAskId)).toBe("closed");
  const closure = await dbQuery(
    `SELECT reason FROM ask_closures WHERE ask_id = ?`,
    [guardAskId],
  );
  expect(String(closure.rows[0]?.reason)).toBe("auto_stale");

  // The aging was artificial; put the ask back the way the seed left it.
  await dbQuery(`UPDATE asks SET status = 'partial' WHERE id = ?`, [guardAskId]);
  await dbQuery(`DELETE FROM ask_closures WHERE ask_id = ?`, [guardAskId]);
  await dbQuery(`UPDATE ask_activity SET affirmed_at = ? WHERE ask_id = ?`, [
    savedAffirm,
    guardAskId,
  ]);
  expect(await askStatus(guardAskId)).toBe("partial");
});

test("08 EXCLUSIVITY: chips on board rows and ask pages; the legacy ask reads terms unspecified", async () => {
  await logIn(page, USER_R.username, USER_R.password);
  await page.goto("/");

  const exclusiveRow = page.locator("li").filter({ hasText: EXCLUSIVE_ASK }).first();
  await expect(exclusiveRow.getByText("exclusive", { exact: true })).toBeVisible();

  const nonexclusiveRow = page.locator("li").filter({ hasText: GUARD_ASK }).first();
  await expect(
    nonexclusiveRow.getByText("non-exclusive", { exact: true }),
  ).toBeVisible();

  const legacyRow = page.locator("li").filter({ hasText: LEGACY_TERMS_ASK }).first();
  await expect(legacyRow.getByText("terms unspecified")).toBeVisible();
  await shot(page, "board-terms-chips");

  // Ask pages carry the same chip in the masthead.
  await page.goto(`/ask/${await askIdByTitle(EXCLUSIVE_ASK)}`);
  await expect(page.getByText("exclusive", { exact: true }).first()).toBeVisible();

  await page.goto(`/ask/${legacyTermsAskId}`);
  await expect(page.getByText("terms unspecified").first()).toBeVisible();
  await shot(page, "ask-terms-unspecified");
  await signOut(page);
});

test("09 SIMILAR + TERMS AT POST TIME: the compose hint counts same-buyer asks, terms are required, Related links land, no name on the wire", async () => {
  // Capture every request the browser makes from here on. The claim under
  // test: the buyer's name appears in none of them, the similar endpoint
  // included; only blinded v2 tokens travel.
  const captured: { url: string; postData: string }[] = [];
  const onRequest = (req: Request) => {
    captured.push({ url: req.url(), postData: req.postData() ?? "" });
  };
  context.on("request", onRequest);

  try {
    await logIn(page, USER_P.username, USER_P.password);
    await page.goto("/new");
    await page.getByLabel("Title").fill(NEW_ASK.title);
    await page.getByLabel("Category").selectOption({ label: NEW_ASK.category });
    await page.getByLabel("Description").fill(NEW_ASK.description);
    await page.getByLabel("Buying lab").selectOption(NEW_ASK.buyer);

    // The quiet hint counts open same-buyer asks. The exact number depends
    // on which suites ran before this one (flow.spec adds Anthropic asks of
    // its own), so read the truth from the DB: every non-closed ask carrying
    // the seeded Anthropic token, minus the one being composed.
    const anthTokenRs = await dbQuery(
      `SELECT buyer_token FROM asks WHERE title = ?`,
      [EXCLUSIVE_ASK],
    );
    const anthToken = String(anthTokenRs.rows[0].buyer_token);
    const openRs = await dbQuery(
      `SELECT COUNT(*) AS n FROM asks WHERE buyer_token = ? AND status != 'closed'`,
      [anthToken],
    );
    const expected = Number(openRs.rows[0].n);
    expect(expected).toBeGreaterThan(0);
    await expect(
      page.getByText(
        `${expected} open ${expected === 1 ? "ask" : "asks"} already ${
          expected === 1 ? "names" : "name"
        } this buyer.`,
      ),
    ).toBeVisible();
    await shot(page, "compose-similar-hint");

    // Terms are required: everything else is filled, posting is refused.
    await expect(
      page.getByRole("button", { name: "Post to the board" }),
    ).toBeDisabled();
    await page.getByText("Non-exclusive", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Post to the board" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Post to the board" }).click();
    await page.waitForURL(/\/ask\/[^/]+$/);
    newAskId = page.url().split("/ask/")[1];

    // The stated terms landed in ask_terms and on the masthead.
    const termsRs = await dbQuery(
      `SELECT exclusivity FROM ask_terms WHERE ask_id = ?`,
      [newAskId],
    );
    expect(String(termsRs.rows[0]?.exclusivity)).toBe("nonexclusive");
    await expect(
      page.getByText("non-exclusive", { exact: true }).first(),
    ).toBeVisible();

    // Related: the open same-buyer ask first, the closed one after, and the
    // count of co-attested deals naming the same buyer (the seeded
    // Anthropic deal, exactly one).
    await expect(page.getByText("Same buyer token")).toBeVisible();
    const openLink = page.getByRole("link", { name: EXCLUSIVE_ASK });
    await expect(openLink).toBeVisible();
    expect(await openLink.getAttribute("href")).toMatch(/^\/ask\//);
    await expect(page.getByRole("link", { name: LEGACY_TERMS_ASK })).toBeVisible();
// Deal counts depend on which suites ran first (deals.spec confirms
    // Anthropic deals of its own), so mirror the component's co-attested
    // query instead of hardcoding.
    const dealRs = await dbQuery(
      `SELECT COUNT(*) AS n FROM deals d
        WHERE d.buyer_token = ?
          AND EXISTS (SELECT 1 FROM deal_participants pc
                       WHERE pc.deal_id = d.id AND pc.role = 'participant'
                         AND pc.status = 'confirmed')
          AND NOT EXISTS (SELECT 1 FROM deal_participants pp
                           WHERE pp.deal_id = d.id AND pp.role = 'participant'
                             AND pp.status = 'pending')`,
      [anthToken],
    );
    const dealCount = Number(dealRs.rows[0].n);
    expect(dealCount).toBeGreaterThan(0);
    await expect(
      page.getByText(
        new RegExp(
          `${dealCount} confirmed deal${dealCount === 1 ? "" : "s"} on this board name${dealCount === 1 ? "s" : ""} the same buyer`,
        ),
      ),
    ).toBeVisible();
    await shot(page, "ask-related-section");

    // The network scan. The hint endpoint was hit, with a blinded token and
    // a category and nothing else; and no request anywhere in this test
    // carried the buyer's name in any casing.
    const similarReqs = captured.filter((r) => r.url.includes("/api/asks/similar"));
    expect(similarReqs.length).toBeGreaterThanOrEqual(1);
    for (const r of similarReqs) {
      const params = new URL(r.url).searchParams;
      expect(params.get("token") ?? "").toMatch(/^v2:[0-9a-f]{128}$/);
      expect([...params.keys()].sort()).toEqual(["category", "token"]);
    }
    const offenders = captured.filter((r) =>
      `${r.url}\n${r.postData}`.toLowerCase().includes("anthropic"),
    );
    expect(offenders, "buyer name found in a request").toEqual([]);

    // The combined-supply view on /matches shows the stated terms; the
    // seeded same-buyer ask is exclusive, so overlap there is competition.
    await page.goto("/matches");
    await expect(page.getByText("Buyer overlap")).toBeVisible();
    await expect(page.getByText(EXCLUSIVE_ASK).first()).toBeVisible();
    await expect(page.getByText("Supply picture").first()).toBeVisible();
    await expect(page.getByText("exclusive", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("states exclusive terms")).toBeVisible();
    await shot(page, "matches-supply-terms");

    await page.goto("/");
    await signOut(page);
  } finally {
    context.off("request", onRequest);
  }
});

test("10 PRIVACY: no PII string appears in any row of any table, new tables included", async () => {
  const literals = [
    USER_P.contact,
    "pia.ortega.test",
    USER_P.realName,
    "piaortega",
    USER_P.org,
    "sablebenchlabs",
    USER_Q.contact,
    "quinn.baker.test",
    USER_Q.realName,
    "quinnbaker",
    USER_R.contact, // "4155559317"
    "1" + USER_R.contact,
    USER_R.realName,
    "rowanslate",
    "example.net",
    "4155550101", // seed contacts, normalized
    "4155550102",
    ...KNOWN_BUYERS,
    ...KNOWN_BUYERS.map((b) => b.toLowerCase().replace(/[^a-z0-9]+/g, "")),
  ];
  const forbidden = [...new Set(literals.map((s) => s.toLowerCase()))];

  // Same carve-out as flow.spec.ts: opaque random ids can contain any short
  // letter run by coin flip, so 3-to-5-char patterns are skipped there only.
  const OPAQUE = /^[A-Za-z0-9_-]{16,}$/;

  const client = createClient({ url: `file:${DB_PATH}` });
  const tablesRs = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const tables = tablesRs.rows.map((r) => String(r.name));
  expect(tables.sort()).toEqual([
    "ask_activity",
    "ask_closures",
    "ask_mandates",
    "ask_terms",
    "asks",
    "collab_requests",
    "deal_close_dates",
    "deal_participants",
    "deal_receipt_signatures",
    "deals",
    "exchange_events",
    "exchange_sessions",
    "exchange_wire_claims",
    "hidden_asks",
    "invite_edges",
    "invites",
    "messages",
    "operators",
    "ops_errors",
    "rate_limits",
    "referral_dispute_status",
    "referral_disputes",
    "referral_settlements",
    "sessions",
    "thread_keys",
    "thread_participants",
    "threads",
    "translog_events",
    "translog_heads",
    "translog_leaves",
    "user_e2ee_keys",
    "user_signing_keys",
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
  client.close();

  // The scan chewed real data: 7 seed users + P/Q/R, 11 seed asks + 1
  // posted here, the two pooling requests plus the seeded legacy one, the
  // seeded deals plus the linked one recorded here, and the lifecycle rows
  // the new features write.
  expect(rowCounts.users).toBeGreaterThanOrEqual(10);
  expect(rowCounts.asks).toBeGreaterThanOrEqual(12);
  expect(rowCounts.collab_requests).toBeGreaterThanOrEqual(3);
  expect(rowCounts.deals).toBeGreaterThanOrEqual(6);
  expect(rowCounts.deal_participants).toBeGreaterThanOrEqual(15);
  expect(rowCounts.ask_terms).toBeGreaterThanOrEqual(11);
  expect(rowCounts.ask_activity).toBeGreaterThanOrEqual(12);
  expect(rowCounts.ask_closures).toBeGreaterThanOrEqual(2);
  expect(rowCounts.threads).toBeGreaterThanOrEqual(8);
  expect(rowCounts.messages).toBeGreaterThanOrEqual(9);

  expect(violations, "PII found in the database").toEqual([]);

  // Raw bytes too, WAL sidecars included, for unambiguous patterns.
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
