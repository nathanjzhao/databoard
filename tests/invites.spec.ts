/**
 * tests/invites.spec.ts
 *
 * Invite-only signup, the invite genealogy, and the referral ledger, driven
 * end to end: the gate refuses missing/bogus/spent codes before any OTP
 * exists, a raced code admits exactly one account, the multi-level ledger
 * accrues 2.5%^depth on co-attested earnings only, standing gates posting,
 * the served-JS manifest script passes against the live server and fails
 * against a corrupted manifest, and none of it leaks PII or genealogy.
 *
 * PRECONDITION: fresh reset + seed, server started after the reset, same as
 * every other suite:
 *
 *   npm run reset-db && npm run seed
 *   npx playwright test tests/invites.spec.ts
 *
 * Serial and stateful on purpose: X and Y are created here and threaded
 * through the ledger tests. All browser and API traffic rides synthetic
 * TEST-NET x-forwarded-for addresses so this suite's invite-check hits land
 * in their own limiter buckets and the shared "local" bucket the other
 * suites use stays untouched (the dev/CI server has no proxy in front, so
 * the header is taken at face value).
 */

import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createClient, type Client } from "@libsql/client";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { unusedInviteCode } from "./invite-codes";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
const VERIFY_DIR = path.join(ROOT, "verify");
const PORT = Number(process.env.PW_PORT ?? 3947);
const BASE = `http://localhost:${PORT}`;

const DEMO_PASSWORD = "demo-demo-demo"; // every seeded account
const INVITE_RE = /^inv_[0-9a-f]{24}$/;
const DAY = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------- test data */

const GATE_USER = {
  realName: "Gwen Doorward",
  contact: "gate.check.test@example.com",
  password: "gate-checks-the-door",
};
const USER_X = {
  realName: "Xavier Chainfield",
  contact: "chain.x.test@example.com",
  password: "x-holds-the-chain-up",
};
const USER_Y = {
  realName: "Yara Downline",
  contact: "chain.y.test@example.com",
  password: "y-earns-forty-thousand",
};
const RACE_ONE = {
  realName: "Rae First",
  contact: "race.one.test@example.com",
  password: "racer-one-at-the-gate",
};
const RACE_TWO = {
  realName: "Ray Second",
  contact: "race.two.test@example.com",
  password: "racer-two-at-the-gate",
};

/** Every PII string typed during this run; none may reach the new tables. */
const PII_STRINGS = [
  GATE_USER.realName, GATE_USER.contact,
  USER_X.realName, USER_X.contact,
  USER_Y.realName, USER_Y.contact,
  RACE_ONE.realName, RACE_ONE.contact,
  RACE_TWO.realName, RACE_TWO.contact,
];

/* ------------------------------------------------------- shared run state */

let context: BrowserContext;
let page: Page;
let xHandle = "";
let yHandle = "";
let gateHandle = "";
let xMintedCode = ""; // the code X mints for Y
let yDealId = ""; // Y's co-attested $50k deal

async function shot(p: Page, name: string) {
  await p.screenshot({ path: path.join(VERIFY_DIR, name), fullPage: true });
}

/* ------------------------------------------------------------ DB helpers */

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = createClient({ url: `file:${DB_PATH}` });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * Internal ledger figures, in cents, read through the REAL computation
 * (lib/referrals.ts computeReferralLedger) against the same database file
 * the server writes. Spawned as a plain node process, exactly the way the
 * seed script runs the lib, so the assertion covers the implementation's
 * arithmetic, not a reimplementation of it in the test.
 */
type ProbeRow = {
  u: string;
  depth: number;
  accrued: number;
  earnings: number;
  settled: number;
  outstanding: number;
};

function ledgerProbe(usernames: string[]): Record<string, ProbeRow[]> {
  const script = `
    import("./lib/referrals.ts").then(async (m) => {
      const { createClient } = await import("@libsql/client");
      const c = createClient({ url: "file:data/app.db" });
      const names = JSON.parse(process.env.LEDGER_USERS);
      const out = {};
      for (const name of names) {
        const rs = await c.execute({ sql: "SELECT id FROM users WHERE username = ?", args: [name] });
        if (rs.rows.length === 0) throw new Error("no user " + name);
        const l = await m.computeReferralLedger(String(rs.rows[0].id));
        out[name] = l.downline.map((d) => ({
          u: d.username, depth: d.depth, accrued: d.accruedCents,
          earnings: d.lifetimeEarningsCents, settled: d.settledCents,
          outstanding: d.outstandingCents,
        }));
      }
      c.close();
      console.log("LEDGER::" + JSON.stringify(out));
      process.exit(0);
    }).catch((e) => { console.error(e); process.exit(1); });
  `;
  const stdout = execFileSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LEDGER_USERS: JSON.stringify(usernames) },
  });
  const line = stdout.split("\n").find((l) => l.startsWith("LEDGER::"));
  expect(line, "ledger probe produced output").toBeTruthy();
  return JSON.parse(line!.slice("LEDGER::".length));
}

function probeRow(probe: Record<string, ProbeRow[]>, owner: string, member: string): ProbeRow {
  const row = (probe[owner] ?? []).find((r) => r.u === member);
  expect(row, `@${member} in @${owner}'s downline`).toBeTruthy();
  return row!;
}

/* ------------------------------------------------------------ UI helpers */

/** Signup, all four screens, with an explicit invite code. */
async function signUp(
  p: Page,
  opts: { inviteCode: string; realName: string; contact: string; password: string },
): Promise<string> {
  await p.goto("/signup");
  await expect(p.getByText("Say who you are, once")).toBeVisible();
  await p.getByLabel("Invite code").fill(opts.inviteCode);
  await p.getByLabel("Real name").fill(opts.realName);
  await p.getByRole("button", { name: "Independent individual" }).click();
  await p.getByLabel("Phone or email").fill(opts.contact);
  await p.getByRole("button", { name: "Send me a code" }).click();

  await expect(p.getByText("Type the code back")).toBeVisible();
  const demoCode = (await p.getByText(/^\d{6}$/).first().textContent())?.trim() ?? "";
  expect(demoCode).toMatch(/^\d{6}$/);
  const codeInput = p.getByLabel("Six digit code");
  await codeInput.fill("");
  await codeInput.fill(demoCode);
  await p.getByRole("button", { name: "Continue" }).click();

  await expect(p.getByText("Pick what we actually keep")).toBeVisible();
  await p.getByLabel("Password").fill(opts.password);
  await p.getByRole("button", { name: "Create account" }).click();

  const handle =
    (await p.getByTestId("assigned-handle").textContent({ timeout: 15_000 }))
      ?.replace(/^@/, "")
      .trim() ?? "";
  expect(handle).toMatch(/^[a-z0-9][a-z0-9_-]{2,23}$/);
  await p.getByRole("button", { name: "Go to the board" }).click();
  await expect(p.getByText(`@${handle}`).first()).toBeVisible({ timeout: 15_000 });
  return handle;
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
  await p.reload();
  await expect(p.getByText(`@${username}`).first()).toBeVisible();
}

/** An API context whose limiter buckets are its own (synthetic client IP). */
function xffContext(ip: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { "x-forwarded-for": ip },
  });
}

/** The downline <tr> for a member on the /invites ledger table. */
function downlineRow(p: Page, member: string) {
  return p.locator("tbody tr").filter({ hasText: `@${member}` });
}

/** The upline <li> for an ancestor on the /invites mirror list. */
function uplineRow(p: Page, ancestor: string) {
  return p
    .locator("li")
    .filter({ hasText: `@${ancestor}` })
    .filter({ hasText: "of your earnings" });
}

/* --------------------------------------------------------------- the run */

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await fs.mkdir(VERIFY_DIR, { recursive: true });
  // All UI traffic in this suite rides one synthetic address, keeping the
  // invite-check / login buckets of the other suites untouched.
  context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "203.0.113.70" },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

/* ---------------------------------------------------------------- 1 GATE */

test("01 GATE: no code, a bogus code, and a spent code are refused before any OTP exists; a valid seeded code reaches a handle", async () => {
  // No code at all, driven at the API (the UI disables the button for a
  // blank code, which is its own refusal): a terse 400 carrying no
  // challenge and no demo code, so no OTP was ever minted or shown.
  const api = await xffContext("203.0.113.71");
  const noCode = await api.post("/api/auth/request-code", {
    data: {
      contact: GATE_USER.contact,
      realName: GATE_USER.realName,
      affiliation: "independent individual",
    },
  });
  expect(noCode.status()).toBe(400);
  const noCodeBody = (await noCode.json()) as Record<string, unknown>;
  expect(String(noCodeBody.error)).toMatch(/invite code/i);
  expect(noCodeBody.challenge).toBeUndefined();
  expect(noCodeBody.demoCode).toBeUndefined();
  await api.dispose();

  // A bogus code through the real form: refused on screen one, and the OTP
  // screen never appears.
  await page.goto("/signup");
  await page.getByLabel("Invite code").fill("inv_000000000000000000000000");
  await page.getByLabel("Real name").fill(GATE_USER.realName);
  await page.getByRole("button", { name: "Independent individual" }).click();
  await page.getByLabel("Phone or email").fill(GATE_USER.contact);
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByText("That invite code is not one we issued.")).toBeVisible();
  await expect(page.getByText("Type the code back")).toHaveCount(0);
  await shot(page, "invites-gate-bogus-code.png");

  // A spent code (any seeded genealogy edge burned one) is told apart
  // tersely, and still goes nowhere.
  const spent = await withDb(async (db) => {
    const rs = await db.execute(
      `SELECT code FROM invites WHERE used_by IS NOT NULL LIMIT 1`,
    );
    return String(rs.rows[0].code);
  });
  expect(spent).toMatch(INVITE_RE);
  await page.getByLabel("Invite code").fill(spent);
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByText("That invite code has been used.")).toBeVisible();
  await expect(page.getByText("Type the code back")).toHaveCount(0);

  // A valid unused code from the seeded pool walks the whole real flow
  // through to an assigned handle.
  gateHandle = await signUp(page, { inviteCode: await unusedInviteCode(), ...GATE_USER });
  await signOut(page);
});

/* --------------------------------------------------------------- 2 CHAIN */

test("02 CHAIN: X joins on quiet-ledger's code, mints one, Y joins on it; each side sees its edge and a third member sees neither", async () => {
  // X's code must come from quiet-ledger so the depth-3 chain of the ledger
  // tests is exact: marble-pennant -> quiet-ledger -> X -> Y. Take a seeded
  // unused quiet-ledger code if one survived the earlier suites, else have
  // quiet-ledger mint one now through the real path.
  let xCode = await withDb(async (db) => {
    const rs = await db.execute(
      `SELECT i.code FROM invites i JOIN users u ON u.id = i.inviter_id
        WHERE u.username = 'quiet-ledger' AND i.used_by IS NULL
        ORDER BY i.created_at, i.code LIMIT 1`,
    );
    return rs.rows.length > 0 ? String(rs.rows[0].code) : "";
  });
  if (!xCode) {
    const ql = await xffContext("203.0.113.72");
    const login = await ql.post("/api/auth/login", {
      data: { username: "quiet-ledger", password: DEMO_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const minted = await ql.post("/api/invites");
    expect(minted.status()).toBe(201);
    xCode = ((await minted.json()) as { code: string }).code;
    await ql.dispose();
  }
  expect(xCode).toMatch(INVITE_RE);

  xHandle = await signUp(page, { inviteCode: xCode, ...USER_X });

  // X mints a code on /invites, through the button a member would use.
  await page.goto("/invites");
  await expect(page.getByText("0 of 5 unused slots held")).toBeVisible();
  await page.getByRole("button", { name: "Mint a code" }).click();
  await expect(page.getByText("1 of 5 unused slots held")).toBeVisible();
  xMintedCode = (await page.getByText(INVITE_RE).first().textContent())?.trim() ?? "";
  expect(xMintedCode).toMatch(INVITE_RE);
  await shot(page, "invites-x-minted.png");
  await signOut(page);

  // Y signs up on X's code.
  yHandle = await signUp(page, { inviteCode: xMintedCode, ...USER_Y });
  expect(yHandle).not.toBe(xHandle);

  // Y's page names X as the voucher.
  await page.goto("/invites");
  await expect(page.getByText(`Invited by @${xHandle}`)).toBeVisible();
  await signOut(page);

  // X's page lists Y as joined on X's code, and the code row reads used.
  await logIn(page, xHandle, USER_X.password);
  await page.goto("/invites");
  await expect(page.getByText(`used by @${yHandle}`)).toBeVisible();
  await expect(
    page.locator("li").filter({ hasText: `@${yHandle}` }).filter({ hasText: "joined" }),
  ).toBeVisible();
  await shot(page, "invites-x-sees-y.png");
  await signOut(page);

  // A third member (paper-trail, on a different branch) sees neither edge:
  // its /invites carries its own chain and not a byte of X's or Y's.
  await logIn(page, "paper-trail", DEMO_PASSWORD);
  await page.goto("/invites");
  await expect(page.getByText("Invited by @granite-fox")).toBeVisible(); // its own edge renders
  const html = await page.content();
  expect(html).not.toContain(`@${xHandle}`);
  expect(html).not.toContain(`@${yHandle}`);
  expect(html).not.toContain(xMintedCode);
  await signOut(page);
});

/* ----------------------------------------------------------------- 3 CAP */

test("03 CAP: a member is refused a sixth unused code; the operator is not", async () => {
  await logIn(page, xHandle, USER_X.password);

  // X's first code is spent (Y), so five mints land X on the cap.
  for (let i = 0; i < 5; i++) {
    const res = await page.request.post("/api/invites");
    expect(res.status(), `mint ${i + 1} of 5`).toBe(201);
  }
  const sixth = await page.request.post("/api/invites");
  expect(sixth.status()).toBe(409);
  expect(((await sixth.json()) as { error: string }).error).toBe(
    "You already hold 5 unused codes. Spend one before minting another.",
  );

  // The same refusal through the UI, terse and visible.
  await page.goto("/invites");
  await expect(page.getByText("5 of 5 unused slots held")).toBeVisible();
  await page.getByRole("button", { name: "Mint a code" }).click();
  await expect(
    page.getByText("You already hold 5 unused codes. Spend one before minting another."),
  ).toBeVisible();
  await expect(page.getByText("5 of 5 unused slots held")).toBeVisible();
  await shot(page, "invites-cap-refused.png");
  await signOut(page);

  // The operator mints past five without complaint.
  await logIn(page, "quiet-ledger", DEMO_PASSWORD);
  for (let i = 0; i < 6; i++) {
    const res = await page.request.post("/api/invites");
    expect(res.status(), `operator mint ${i + 1} of 6`).toBe(201);
  }
  await page.goto("/invites");
  await expect(page.getByText(/\d+ unused, uncapped \(operator\)/)).toBeVisible();
  const label =
    (await page.getByText(/\d+ unused, uncapped \(operator\)/).textContent()) ?? "";
  expect(Number(label.match(/^(\d+) unused/)?.[1] ?? 0)).toBeGreaterThanOrEqual(6);
  await signOut(page);
});

/* ---------------------------------------------------------------- 4 RACE */

test("04 RACE: one code, two concurrent signups, exactly one account", async () => {
  const raceCode = await unusedInviteCode();

  // Two challenges, two synthetic client addresses, one invite code.
  const ctxOne = await xffContext("203.0.113.73");
  const ctxTwo = await xffContext("203.0.113.74");
  const challenges: { challenge: string; demoCode: string }[] = [];
  for (const [ctx, who] of [
    [ctxOne, RACE_ONE],
    [ctxTwo, RACE_TWO],
  ] as const) {
    const res = await ctx.post("/api/auth/request-code", {
      data: {
        inviteCode: raceCode,
        contact: who.contact,
        realName: who.realName,
        affiliation: "independent individual",
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { challenge: string; demoCode: string };
    expect(body.demoCode).toMatch(/^\d{6}$/);
    challenges.push({ challenge: body.challenge, demoCode: body.demoCode });
  }

  const usersBefore = await withDb(async (db) =>
    Number((await db.execute(`SELECT COUNT(*) AS n FROM users`)).rows[0].n),
  );

  const [resOne, resTwo] = await Promise.all([
    ctxOne.post("/api/auth/verify-and-signup", {
      data: {
        inviteCode: raceCode,
        contact: RACE_ONE.contact,
        realName: RACE_ONE.realName,
        affiliation: "independent individual",
        code: challenges[0].demoCode,
        challenge: challenges[0].challenge,
        password: RACE_ONE.password,
      },
    }),
    ctxTwo.post("/api/auth/verify-and-signup", {
      data: {
        inviteCode: raceCode,
        contact: RACE_TWO.contact,
        realName: RACE_TWO.realName,
        affiliation: "independent individual",
        code: challenges[1].demoCode,
        challenge: challenges[1].challenge,
        password: RACE_TWO.password,
      },
    }),
  ]);

  const statuses = [resOne.status(), resTwo.status()].sort();
  expect(statuses[0], "exactly one of the two signups wins").toBe(200);
  expect([400, 409]).toContain(statuses[1]);
  const loser = resOne.status() === 200 ? resTwo : resOne;
  expect(((await loser.json()) as { error: string }).error).toMatch(/invite code/i);

  // The code is spent exactly once, one edge exists, one account was kept.
  await withDb(async (db) => {
    const invite = await db.execute({
      sql: `SELECT used_by FROM invites WHERE code = ?`,
      args: [raceCode],
    });
    expect(invite.rows[0].used_by).not.toBeNull();
    const edges = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM invite_edges WHERE invite_code = ?`,
      args: [raceCode],
    });
    expect(Number(edges.rows[0].n)).toBe(1);
    const usersAfter = Number(
      (await db.execute(`SELECT COUNT(*) AS n FROM users`)).rows[0].n,
    );
    expect(usersAfter, "the losing signup's account row was rolled back").toBe(
      usersBefore + 1,
    );
  });

  await ctxOne.dispose();
  await ctxTwo.dispose();
});

/* -------------------------------------------------------------- 5 LEDGER */

test("05 LEDGER: Y's co-attested $40k share accrues 2.5%^depth to X, quiet-ledger, marble-pennant; a solo claim moves nothing; settlement records two-sided", async () => {
  // Y records the deal: $50k total, Y's share $40k, attic-lantern (an
  // account with no invite chain, so its share contaminates no ancestor
  // ledger) named for $10k.
  await logIn(page, yHandle, USER_Y.password);
  await page.goto("/deals/new");
  await expect(page.getByText("Say what closed, and who was in it.")).toBeVisible();
  await page.getByLabel("Buying lab").selectOption("Cohere");
  await page.getByLabel("Total value, USD").fill("50000");
  await page.getByLabel("Your share, USD").fill("40000");
  await page.getByRole("button", { name: "+ add participant" }).click();
  await page.getByLabel("Participant handle").first().fill("attic-lantern");
  await page.getByLabel("Participant share in USD").first().fill("10000");
  await page.getByRole("button", { name: "Record the deal" }).click();
  await page.waitForURL(/\/deals\/(?!new$)[^/]+$/);
  yDealId = page.url().split("/deals/")[1];
  await signOut(page);

  // Before the co-attestation the deal is a claim: nothing accrues.
  const claimed = ledgerProbe([xHandle]);
  expect(probeRow(claimed, xHandle, yHandle).accrued).toBe(0);

  // attic-lantern confirms its row through the API (the same route the
  // confirm button posts to). Deliberately NOT a browser login: signing the
  // legacy account into the UI would derive and register an e2ee key for
  // it, and the trust suite depends on attic-lantern staying the one
  // keyless account whose seeded thread renders "not end-to-end encrypted".
  const attic = await xffContext("203.0.113.75");
  const atticLogin = await attic.post("/api/auth/login", {
    data: { username: "attic-lantern", password: DEMO_PASSWORD },
  });
  expect(atticLogin.status()).toBe(200);
  const confirmRes = await attic.post(`/api/deals/${yDealId}`, {
    data: { action: "confirm" },
  });
  expect(confirmRes.status()).toBe(200);
  await attic.dispose();

  // INTERNAL figures, integer cents, through the real computation:
  // depth 1 (X)             40000_00 / 40   = 100000 = $1,000
  // depth 2 (quiet-ledger)  40000_00 / 1600 =   2500 = $25
  // depth 3 (marble-pennant) 40000_00 / 64000 = 62.5 -> Math.round -> 63
  // The implementation rounds half up once per (share, ancestor) pair, so
  // the root's accrual is exactly 63 cents, displayed whole-dollar as $1.
  const probe = ledgerProbe([xHandle, "quiet-ledger", "marble-pennant"]);
  const yForX = probeRow(probe, xHandle, yHandle);
  expect(yForX).toMatchObject({ depth: 1, accrued: 100000, earnings: 4000000 });
  expect(probeRow(probe, "quiet-ledger", yHandle)).toMatchObject({
    depth: 2,
    accrued: 2500,
  });
  expect(probeRow(probe, "marble-pennant", yHandle)).toMatchObject({
    depth: 3,
    accrued: 63,
  });

  // The same figures on the pages, rounded to whole dollars for display.
  await logIn(page, xHandle, USER_X.password);
  await page.goto("/invites");
  const xRow = downlineRow(page, yHandle);
  await expect(xRow.locator("td").nth(1)).toContainText("step 1");
  await expect(xRow.locator("td").nth(2)).toHaveText("$40,000");
  await expect(xRow.locator("td").nth(3)).toHaveText("$1,000");
  await expect(xRow.locator("td").nth(5)).toHaveText("$1,000");
  await shot(page, "invites-x-ledger.png");
  await signOut(page);

  await logIn(page, "marble-pennant", DEMO_PASSWORD);
  await page.goto("/invites");
  const mpRow = downlineRow(page, yHandle);
  await expect(mpRow.locator("td").nth(1)).toContainText("step 3");
  await expect(mpRow.locator("td").nth(3)).toHaveText("$1"); // 63 cents, whole-dollar display
  await shot(page, "invites-root-ledger.png");
  await signOut(page);

  // A solo claimed deal moves nothing at any depth.
  await logIn(page, yHandle, USER_Y.password);
  await page.goto("/deals/new");
  await page.getByLabel("Buying lab").selectOption("Cohere");
  await page.getByLabel("Total value, USD").fill("5000");
  await page.getByLabel("Your share, USD").fill("5000");
  await page.getByRole("button", { name: "Record the deal" }).click();
  await page.waitForURL(/\/deals\/(?!new$)[^/]+$/);
  await signOut(page);

  const afterSolo = ledgerProbe([xHandle, "quiet-ledger", "marble-pennant"]);
  expect(probeRow(afterSolo, xHandle, yHandle).accrued).toBe(100000);
  expect(probeRow(afterSolo, xHandle, yHandle).earnings).toBe(4000000); // the $5k claim is not an earning
  expect(probeRow(afterSolo, "quiet-ledger", yHandle).accrued).toBe(2500);
  expect(probeRow(afterSolo, "marble-pennant", yHandle).accrued).toBe(63);

  // X (the payee, against its own interest) records a $600 off-platform
  // settlement on Y's row. NOTE the shipped semantics, stated on the page
  // ("your record is what reduces the debt"): the payee's one-sided record
  // counts immediately; the payer's confirmation is what makes the receipt
  // mutual. So outstanding drops to $400 on recording, and confirming
  // changes the figure no further.
  await logIn(page, xHandle, USER_X.password);
  await page.goto("/invites");
  await downlineRow(page, yHandle)
    .getByRole("button", { name: "Record settlement" })
    .click();
  await downlineRow(page, yHandle).getByPlaceholder("0.00").fill("600");
  await downlineRow(page, yHandle).getByPlaceholder("note (optional)").fill("wire ref 88");
  const [recordRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/invites/settle")),
    downlineRow(page, yHandle).getByRole("button", { name: "Record received" }).click(),
  ]);
  expect(recordRes.status()).toBe(201);
  await expect(downlineRow(page, yHandle).locator("td").nth(4)).toHaveText("$600");
  await expect(downlineRow(page, yHandle).locator("td").nth(5)).toHaveText("$400");
  await shot(page, "invites-x-settled.png");
  await signOut(page);

  // The record is visibly one-sided until Y confirms it: unconfirmed, it
  // does not become a mutual receipt (Y still sees the Confirm button), and
  // it moves nothing anywhere else in the chain.
  const afterRecord = ledgerProbe([xHandle, "quiet-ledger"]);
  expect(probeRow(afterRecord, xHandle, yHandle)).toMatchObject({
    settled: 60000,
    outstanding: 40000,
  });
  expect(probeRow(afterRecord, "quiet-ledger", yHandle)).toMatchObject({
    settled: 0,
    outstanding: 2500,
  });

  await logIn(page, yHandle, USER_Y.password);
  await page.goto("/invites");
  const xUpline = uplineRow(page, xHandle);
  await expect(xUpline).toContainText("$600 settled");
  await expect(xUpline).toContainText("$400 outstanding");
  await expect(xUpline).toContainText("wire ref 88");
  const [confirmSettleRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/invites/settle")),
    xUpline.getByRole("button", { name: "Confirm", exact: true }).click(),
  ]);
  expect(confirmSettleRes.status()).toBe(200);
  await expect(xUpline.getByText("confirmed by you")).toBeVisible();
  await expect(xUpline).toContainText("$400 outstanding"); // confirming moves no figure
  await shot(page, "invites-y-confirmed-settlement.png");
  await signOut(page);
});

/* ------------------------------------------------------------ 6 STANDING */

test("06 STANDING: 60-day-old outstanding accruals block Y from posting; disputes lift the block and reach the operator", async () => {
  // Age the qualifying deal past the 60-day grace window, the same direct
  // timestamp surgery flows.spec applies to ask_activity. The accrual clock
  // is the deal's last confirmation timestamp.
  await withDb(async (db) => {
    await db.execute({
      sql: `UPDATE deal_participants SET confirmed_at = confirmed_at - ?
             WHERE deal_id = ? AND confirmed_at IS NOT NULL`,
      args: [61 * DAY, yDealId],
    });
  });

  // Y is behind on two pairs: X ($400) and quiet-ledger ($25).
  // marble-pennant's 63 cents is dust below the $1 floor and never gates.
  await logIn(page, yHandle, USER_Y.password);
  await page.goto("/invites");
  await expect(page.getByText("Behind on referral obligations")).toBeVisible();
  await expect(page.getByText(`@${xHandle}: $400 outstanding`)).toBeVisible();
  await expect(page.getByText("@quiet-ledger: $25 outstanding")).toBeVisible();
  await expect(page.getByText("@marble-pennant: $")).toHaveCount(0);
  await shot(page, "invites-y-behind-banner.png");

  // Posting an ask is refused with the terse standing copy.
  await page.goto("/new");
  await page.getByLabel("Title").fill("Calibrated tide-gauge logs with maintenance records");
  await page.getByLabel("Category").selectOption({ label: "Eval / benchmark data" });
  await page
    .getByLabel("Description")
    .fill("Hourly tide-gauge series from private harbor networks, with per-station maintenance and calibration logs so drift is modelable.");
  await page.getByLabel("Buying lab").selectOption("Cohere");
  await page.getByText("Non-exclusive", { exact: true }).click();
  await page.getByRole("button", { name: "Post to the board" }).click();
  await expect(
    page.getByText(
      "This account is behind on referral obligations. Settle or dispute them on the invites page first.",
    ),
  ).toBeVisible();
  await shot(page, "invites-y-post-blocked.png");

  // The block is the SERVER's, not the UI's: the APIs refuse directly.
  // (page.request rides Y's session cookies.)
  const dealApi = await page.request.post("/api/deals", {
    data: { buyerToken: "v2:" + "0".repeat(128), totalValueUsd: 1000, note: "", participants: [] },
  });
  expect(dealApi.status()).toBe(403);
  expect((await dealApi.json()).error).toContain("behind on referral obligations");
  const mintApi = await page.request.post("/api/invites", { data: {} });
  expect(mintApi.status()).toBe(403);
  expect((await mintApi.json()).error).toContain("behind on referral obligations");

  // Disputing the X pair alone is not enough: quiet-ledger's $25 still gates.
  await page.goto("/invites");
  const [d1] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/invites/dispute")),
    uplineRow(page, xHandle).getByRole("button", { name: "Dispute" }).click(),
  ]);
  expect(d1.status()).toBe(201);
  await expect(uplineRow(page, xHandle).getByText("disputed")).toBeVisible();
  await expect(page.getByText("Behind on referral obligations")).toBeVisible();

  // Disputing the second pair lifts the block.
  const [d2] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/invites/dispute")),
    uplineRow(page, "quiet-ledger").getByRole("button", { name: "Dispute" }).click(),
  ]);
  expect(d2.status()).toBe(201);
  await expect(uplineRow(page, "quiet-ledger").getByText("disputed")).toBeVisible();
  await expect(page.getByText("Behind on referral obligations")).toHaveCount(0);
  await shot(page, "invites-y-disputed.png");

  // And the same ask now posts.
  await page.goto("/new");
  await page.getByLabel("Title").fill("Calibrated tide-gauge logs with maintenance records");
  await page.getByLabel("Category").selectOption({ label: "Eval / benchmark data" });
  await page
    .getByLabel("Description")
    .fill("Hourly tide-gauge series from private harbor networks, with per-station maintenance and calibration logs so drift is modelable.");
  await page.getByLabel("Buying lab").selectOption("Cohere");
  await page.getByText("Non-exclusive", { exact: true }).click();
  await page.getByRole("button", { name: "Post to the board" }).click();
  await page.waitForURL(/\/ask\/[^/]+$/);
  await signOut(page);

  // X sees the pair disputed on its side of the ledger.
  await logIn(page, xHandle, USER_X.password);
  await page.goto("/invites");
  await expect(downlineRow(page, yHandle).getByText("disputed")).toBeVisible();
  await signOut(page);

  // The operator's /invites lists both open disputes.
  await logIn(page, "quiet-ledger", DEMO_PASSWORD);
  await page.goto("/invites");
  await expect(page.getByText("Open disputes")).toBeVisible();
  await expect(page.getByText(`@${yHandle} owes @${xHandle}`)).toBeVisible();
  await expect(page.getByText(`@${yHandle} owes @quiet-ledger`)).toBeVisible();
  await shot(page, "invites-operator-disputes.png");
  await signOut(page);
});

/* ------------------------------------------------------------ 7 MANIFEST */

test("07 MANIFEST: verify-served-js.sh passes against the live server and fails against a corrupted manifest", async () => {
  const script = path.join(ROOT, "scripts", "verify-served-js.sh");

  // The script is run ASYNC both times: the corrupted-manifest run talks to
  // a proxy served from this very process, so a synchronous spawn would
  // deadlock (curl waiting on an event loop that is blocked waiting on
  // curl).
  function runScript(
    base: string,
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        "bash",
        [script, base, "all"],
        { encoding: "utf8", timeout: 60_000 },
        (err, stdout, stderr) => {
          const status =
            err == null ? 0 : typeof err.code === "number" ? err.code : 1;
          resolve({ status, stdout, stderr });
        },
      );
    });
  }

  // The honest pass: every file the server's own manifest lists hashes out.
  const pass = await runScript(BASE);
  expect(pass.status, pass.stderr).toBe(0);
  expect(pass.stdout).toContain("0 failed");
  expect(pass.stdout).toMatch(/\bok\s{4}/);

  // Guard sensitivity: one flipped sha256 in a COPY of the manifest must
  // fail the run. A tiny local proxy serves the corrupted copy at the
  // manifest path and passes /_next/static through to the real server.
  const manifest = (await (await fetch(`${BASE}/api/transparency/js-manifest`)).json()) as {
    files: { path: string; sha256: string; bytes: number }[];
  };
  expect(manifest.files.length).toBeGreaterThan(0);
  const corrupted = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  corrupted.files[0].sha256 =
    (corrupted.files[0].sha256[0] === "0" ? "1" : "0") + corrupted.files[0].sha256.slice(1);

  const proxy = http.createServer(async (req, res) => {
    try {
      if (req.url === "/api/transparency/js-manifest") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(corrupted));
        return;
      }
      const upstream = await fetch(`${BASE}${req.url}`);
      res.statusCode = upstream.status;
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.statusCode = 502;
      res.end();
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;

  try {
    const failed = await runScript(`http://127.0.0.1:${proxyPort}`);
    expect(failed.status, "the script must exit nonzero against a corrupted manifest").toBe(1);
    const output = failed.stdout + failed.stderr;
    expect(output).toContain(`FAIL  ${corrupted.files[0].path}`);
    expect(output).toContain("1 failed");
  } finally {
    proxy.close();
  }
});

/* ------------------------------------------------------------- 8 PRIVACY */

test("08 PRIVACY: the invite and referral tables hold tokens and integers, never PII; genealogy reaches no third party's pages", async () => {
  const tables = ["invites", "invite_edges", "referral_settlements", "referral_disputes"];
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  /** Every offending "table.column=value" across the four tables. */
  async function scanTables(db: Client): Promise<string[]> {
    const violations: string[] = [];
    for (const table of tables) {
      const rs = await db.execute(`SELECT * FROM ${table}`);
      for (const row of rs.rows) {
        for (const col of rs.columns) {
          const value = String(row[col] ?? "");
          const hit =
            EMAIL_RE.test(value) ||
            value.includes("415 555") ||
            PII_STRINGS.some((s) => value.toLowerCase().includes(s.toLowerCase()));
          if (hit) violations.push(`${table}.${col}=${value}`);
        }
      }
    }
    return violations;
  }

  await withDb(async (db) => {
    // The scanner is proven sensitive first: a planted email in a
    // settlement note MUST be flagged, then the plant is removed.
    await db.execute({
      sql: `INSERT INTO referral_settlements
              (id, payer_id, payee_id, amount_cents, note, settled_at, confirmed_by_payer)
            SELECT 'rst_sentinel_privacy_probe', id, id, 1, 'paid to sentinel-pii@example.com', 0, 0
              FROM users LIMIT 1`,
      args: [],
    });
    const planted = await scanTables(db);
    expect(planted, "the scanner catches a planted address").toEqual([
      "referral_settlements.note=paid to sentinel-pii@example.com",
    ]);
    await db.execute(`DELETE FROM referral_settlements WHERE id = 'rst_sentinel_privacy_probe'`);

    // The real scan: nothing.
    expect(await scanTables(db)).toEqual([]);

    // Codes are inv_-prefixed server-minted tokens, nothing else, on both
    // the bookkeeping table and the permanent genealogy.
    const codes = await db.execute(
      `SELECT code FROM invites UNION ALL SELECT invite_code FROM invite_edges`,
    );
    expect(codes.rows.length).toBeGreaterThan(0);
    for (const r of codes.rows) {
      expect(String(r.code)).toMatch(INVITE_RE);
    }
  });

  // The genealogy of X reaches no page served to a third member. Its own
  // edge rendering above (test 02) is the positive control that /invites is
  // exactly where genealogy WOULD appear.
  await logIn(page, "paper-trail", DEMO_PASSWORD);
  for (const route of ["/invites", "/leaderboard", "/", "/deals"]) {
    await page.goto(route);
    const html = await page.content();
    expect(html, `@${xHandle} on ${route}`).not.toContain(`@${xHandle}`);
    expect(html.toLowerCase(), `"invited by" on ${route}`).not.toContain(
      route === "/invites" ? `invited by @${xHandle}` : "invited by",
    );
  }
  // Y earns and trades in public (leaderboard, deals) by design; Y's EDGES
  // stay private: a third member's /invites knows nothing of Y, or of the
  // account signed up at the gate in test 01.
  await page.goto("/invites");
  const inviteHtml = await page.content();
  expect(inviteHtml).not.toContain(`@${yHandle}`);
  expect(inviteHtml).not.toContain(`@${gateHandle}`);
  await signOut(page);
});
