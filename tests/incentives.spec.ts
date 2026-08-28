/**
 * tests/incentives.spec.ts
 *
 * The recording incentive: the two features that make being on the record
 * worth more than the 2.5% fee it costs, driven end to end plus proven against
 * independent math, each test carrying a counterfactual the pre-change code
 * would have failed.
 *
 *   A  PORTABLE SIGNED RECEIPTS. A co-attested deal mints an HMAC-signed token
 *      that a public GET/POST /api/receipts/verify confirms genuine; a solo /
 *      claimed deal mints nothing and shows no affordance; one altered
 *      character fails the check.
 *   B  RECORDED-VOLUME MATCHING PRIORITY. A poster with confirmed recorded
 *      volume sorts ahead of an equally-recent record-empty poster and wears a
 *      bucketed track-record chip; the record-empty poster still appears.
 *   C  TIER WEIGHT + SYBIL DISCOUNT. An evidence-committed dollar outranks a
 *      co-attested one; a confirmation from inside the reporter's own invite
 *      subtree accrues the fee but earns zero collaborator / value-to-others
 *      credit, until the confirmer grows independent history.
 *   D  OPERATOR GRAPH SIGNALS. /api/admin/signals returns the three ranked
 *      lists to an operator and denies everyone else.
 *   PRIVACY  No new tables; receipts and signals carry only bucketed dollars
 *      and public handles, never an exact figure or any PII.
 *
 * SHARED-DB DISCIPLINE. Like every suite here this runs on one seeded database
 * that earlier suites have already written to, so it creates its OWN accounts,
 * asserts RELATIVE order (not absolute board position), and reuses the seed's
 * two-branch invite tree only for the sybil cases the seed was built to show.
 *
 * PRECONDITION: freshly reset + seeded DB and the built app on port 3947, the
 * same way CI runs every suite:
 *   SERVER_PEPPER=... npm run reset-db && npm run seed
 *   CI=1 SERVER_PEPPER=... npx playwright test tests/incentives.spec.ts
 */

import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createClient } from "@libsql/client";
import path from "node:path";

import {
  mintReceiptForDeal,
  receiptPayloadForDeal,
  RECEIPT_PREFIX,
  type ReceiptPayload,
} from "../lib/receipts";
import {
  recordedVolumeChip,
  recordedVolumeBucket,
  comparePriority,
  recorderStanding,
  TRUSTED_RECORDER_MIN_TIER,
  RECORDED_VOLUME_BUCKETS,
  type PriorityInput,
} from "../lib/matching";
import {
  maxUnusedInvites,
  MAX_UNUSED_INVITES,
  MAX_STANDING_INVITE_BONUS,
} from "../lib/invites";
import {
  provenanceLine,
  certificateDate,
  CERTIFICATE_DISPUTE_WINDOW_DAYS,
} from "../lib/receipts";
import {
  tierValueWeight,
  WEIGHT_CO_ATTESTED,
  WEIGHT_EVIDENCE_COMMITTED,
} from "../lib/stats";
import {
  isDiscountedConfirmer,
  isSybilRelated,
  INDEPENDENCE_MIN_AGE_MS,
  type InviteGraph,
  type IndependenceContext,
} from "../lib/independence";
import {
  earningEventsFor,
  computeReferralLedger,
  recordingCreditBps,
  netAccrualCents,
  accrualCents,
  TIMELY_EVIDENCE_CREDIT_BPS,
  TIMELY_RECORDING_WINDOW_MS,
} from "../lib/referrals";
import type { DealDetail } from "../lib/deals";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");

/** One process-unique tag so re-runs against a non-reset DB never collide. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PW = "incentives-verify-000";

/* -------------------------------------------------------------- test data */

// Reporter with recorded volume: mints a receipt, wears a track chip, is a
// fee-sink and a remainder-outlier signal.
const REC = { realName: "Rina Vale", org: "Recorder Collective", contact: `rec-${RUN}@example.org`, handle: "" };
// Confirms REC's main deal, so that deal is co-attested.
const PART = { realName: "Pia Storm", contact: `part-${RUN}@example.org`, handle: "" };
// Record-empty poster: an ask, no deals, no chip, lower priority, still shown.
const EMPTY = { realName: "E Nolan", contact: `empty-${RUN}@example.org`, handle: "" };
// A sock: confirms one reporter's deal only, no deals of its own, no asks.
const SOCK = { realName: "S Okonkwo", contact: `sock-${RUN}@example.org`, handle: "" };

// REC's main co-attested deal. Exact total is deliberately not a round $10k so
// the bucket ($120k) is provably different from the exact figure (123456).
const DEAL_M = { buyer: "Anthropic", total: "123456", myShare: "60000", partShare: "30000" };
// Lopsided deal: 90% unallocated -> REC is a remainder outlier; SOCK confirms.
const DEAL_L = { buyer: "OpenAI", total: "200000", myShare: "10000", sockShare: "10000" };
// Solo claim: mints no receipt, shows no receipt affordance.
const DEAL_S = { buyer: "Anthropic", total: "8000", myShare: "8000" };

const REC_ASK = {
  title: `INCENTIVES recorded-volume ask ${RUN}`,
  category: "Eval / benchmark data",
  buyer: "Anthropic",
  pct: 20,
  description: "Board-style clinical vignettes with gold answers. Track-record poster.",
};
const EMPTY_ASK = {
  title: `INCENTIVES record-empty ask ${RUN}`,
  category: "Eval / benchmark data",
  buyer: "Anthropic",
  pct: 20,
  description: "Board-style clinical vignettes with gold answers. Record-empty poster.",
};

/* ------------------------------------------------------- shared run state */

let context: BrowserContext;
let page: Page;
let dealMId = "";
let dealSId = "";

/* ------------------------------------------------------------ DB helpers */

function db() {
  return createClient({ url: `file:${DB_PATH}` });
}

async function userId(username: string): Promise<string> {
  const c = db();
  const rs = await c.execute({ sql: `SELECT id FROM users WHERE username = ?`, args: [username] });
  c.close();
  expect(rs.rows.length, `user @${username} not found`).toBe(1);
  return String(rs.rows[0].id);
}

async function askByTitle(title: string): Promise<{ id: string; posterId: string; createdAt: number }> {
  const c = db();
  const rs = await c.execute({
    sql: `SELECT id, user_id, created_at FROM asks WHERE title = ?`,
    args: [title],
  });
  c.close();
  expect(rs.rows.length, `ask "${title}" not found`).toBe(1);
  return { id: String(rs.rows[0].id), posterId: String(rs.rows[0].user_id), createdAt: Number(rs.rows[0].created_at) };
}

/* ------------------------------------------------------------ UI helpers */

/**
 * Fresh invite codes minted by the seeded operator through the real
 * POST /api/invites path. Minting instead of drawing from the seeded pool is
 * deliberate: the shared suites downstream of this one (invites, responsive)
 * consume that pool by earliest-created code, so spending it here would shift
 * which inviter their accounts attach to and starve their signups. A minted
 * code sorts AFTER every seed code, so unusedInviteCode() is untouched, and
 * these four accounts hang under the operator, off every genealogy those
 * suites assert about.
 *
 * marble-pennant, not quiet-ledger, is the operator used here and for the D /
 * PRIVACY signal checks: quiet-ledger is the account the responsive suite logs
 * in as on every viewport, and login is capped at ten per handle per five
 * minutes, so spending that budget here would starve responsive's own logins.
 * marble-pennant is the other seeded operator and no later suite leans on it.
 */
const OPERATOR = { username: "marble-pennant", password: "demo-demo-demo" };

async function mintOperatorCodes(api: APIRequestContext, n: number): Promise<string[]> {
  const xff = { "x-forwarded-for": `198.51.100.${40 + Math.floor(Math.random() * 150)}` };
  const login = await api.post("/api/auth/login", {
    headers: xff,
    data: { username: OPERATOR.username, password: OPERATOR.password },
  });
  expect(login.status(), "operator login for minting").toBe(200);
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = await api.post("/api/invites", { headers: xff });
    expect(m.status(), "mint invite code").toBe(201);
    codes.push(String((await m.json()).code));
  }
  return codes;
}

async function signUp(
  p: Page,
  opts: { realName: string; org?: string; contact: string; inviteCode: string },
): Promise<string> {
  await p.goto("/signup");
  await expect(p.getByText("Say who you are, once")).toBeVisible();
  await p.getByLabel("Invite code").fill(opts.inviteCode);
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
  await p.getByLabel("Password").fill(PW);
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

async function logIn(p: Page, username: string, password = PW) {
  await p.goto("/login");
  await p.getByLabel("Handle").fill(username);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname === "/");
  await p.reload();
  await expect(p.getByText(`@${username}`).first()).toBeVisible();
}

async function recordDeal(
  p: Page,
  opts: { buyer: string; total: string; myShare: string; participants: [string, string][] },
): Promise<string> {
  await p.goto("/deals/new");
  await expect(p.getByText("Say what closed, and who was in it.")).toBeVisible();
  await p.getByLabel("Buying lab").selectOption(opts.buyer);
  await p.getByLabel("Total value, USD").fill(opts.total);
  await p.getByLabel("Your share, USD").fill(opts.myShare);
  for (let i = 0; i < opts.participants.length; i++) {
    await p.getByRole("button", { name: "+ add participant" }).click();
    const [handle, share] = opts.participants[i];
    await p.getByLabel("Participant handle").nth(i).fill(handle);
    await p.getByLabel("Participant share in USD").nth(i).fill(share);
  }
  await p.getByRole("button", { name: "Record the deal" }).click();
  await p.waitForURL(/\/deals\/(?!new$)[^/]+$/);
  return p.url().split("/deals/")[1];
}

async function confirmMyShare(p: Page) {
  await p.goto("/deals");
  await expect(p.getByText("Needs your confirmation")).toBeVisible();
  const [res] = await Promise.all([
    p.waitForResponse((r) => r.request().method() === "POST" && /\/api\/deals\/[^/]+$/.test(r.url())),
    p.getByRole("button", { name: /Confirm my \$/ }).first().click(),
  ]);
  expect(res.status(), `POST ${res.url()}`).toBe(200);
}

async function postAsk(p: Page, ask: typeof REC_ASK): Promise<void> {
  await p.goto("/new");
  await p.getByLabel("Title").fill(ask.title);
  await p.getByLabel("Category").selectOption({ label: ask.category });
  await p.getByLabel("Description").fill(ask.description);
  await p.getByLabel("Buying lab").selectOption(ask.buyer);
  await p.getByText("Non-exclusive", { exact: true }).click();
  await p.getByRole("button", { name: "Post to the board" }).click();
  await p.waitForURL(/\/ask\/[^/]+$/);
  await expect(p.getByRole("heading", { name: ask.title })).toBeVisible();
}

/* --------------------------------------------------------------- fixture */

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  // A distinct forwarded-for so this suite's ~dozen logins land in their own
  // rate-limit bucket, never the shared localhost one the responsive and
  // mandate suites log in against. lib/ratelimit.ts keys the per-IP login
  // limit on this header.
  context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.198" },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("00 fixture: four accounts, three deals, two asks, two confirmations", async ({ request }) => {
  const [cRec, cPart, cEmpty, cSock] = await mintOperatorCodes(request, 4);
  REC.handle = await signUp(page, { realName: REC.realName, org: REC.org, contact: REC.contact, inviteCode: cRec });
  await signOut(page);
  PART.handle = await signUp(page, { realName: PART.realName, contact: PART.contact, inviteCode: cPart });
  await signOut(page);
  EMPTY.handle = await signUp(page, { realName: EMPTY.realName, contact: EMPTY.contact, inviteCode: cEmpty });
  await signOut(page);
  SOCK.handle = await signUp(page, { realName: SOCK.realName, contact: SOCK.contact, inviteCode: cSock });
  await signOut(page);

  // REC reports all three deals.
  await logIn(page, REC.handle);
  dealMId = await recordDeal(page, {
    buyer: DEAL_M.buyer,
    total: DEAL_M.total,
    myShare: DEAL_M.myShare,
    participants: [[PART.handle, DEAL_M.partShare]],
  });
  await recordDeal(page, {
    buyer: DEAL_L.buyer,
    total: DEAL_L.total,
    myShare: DEAL_L.myShare,
    participants: [[SOCK.handle, DEAL_L.sockShare]],
  });
  dealSId = await recordDeal(page, {
    buyer: DEAL_S.buyer,
    total: DEAL_S.total,
    myShare: DEAL_S.myShare,
    participants: [],
  });
  // REC's ask goes up FIRST, so the record-empty ask is strictly newer.
  await postAsk(page, REC_ASK);
  await signOut(page);

  // Confirmations make DEAL_M co-attested and seat SOCK as a one-reporter sock.
  await logIn(page, PART.handle);
  await confirmMyShare(page);
  await signOut(page);
  await logIn(page, SOCK.handle);
  await confirmMyShare(page);
  await signOut(page);

  // The record-empty ask, newer than REC's, by a poster with no deals at all.
  await logIn(page, EMPTY.handle);
  await postAsk(page, EMPTY_ASK);
  await signOut(page);

  expect(dealMId.length).toBeGreaterThan(0);
  expect(dealSId.length).toBeGreaterThan(0);
});

/* ------------------------------------------------------- A: RECEIPTS */

test("A1 co-attested deal mints a receipt; the public verifier confirms it, with only the bucket", async () => {
  await logIn(page, REC.handle);
  await page.goto(`/deals/${dealMId}`);

  // The affordance exists only because the deal is attested.
  await expect(page.getByText("Portable receipt")).toBeVisible();
  await expect(page.getByText("co-attested").first()).toBeVisible();

  await page.getByRole("button", { name: "Show token" }).click();
  const token = (await page.getByText(new RegExp(`^${RECEIPT_PREFIX}\\.`)).first().innerText()).trim();
  expect(token).toMatch(new RegExp(`^${RECEIPT_PREFIX}\\.[A-Za-z0-9_-]+\\.[0-9a-f]+$`));

  // The public POST verifier: no session needed, uses this page's own request
  // context. Genuine token -> valid with the attested fields.
  const res = await page.request.post("/api/receipts/verify", { data: { token } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { valid: boolean; receipt: ReceiptPayload };
  expect(body.valid).toBe(true);
  expect(body.receipt.tier).toBe("co_attested");
  expect(body.receipt.dealId).toBe(dealMId);
  expect(body.receipt.buyerIsOther).toBe(false);
  // Confirmed handles only, sorted: REC (reporter) + PART.
  expect(body.receipt.participants).toEqual([REC.handle, PART.handle].sort((a, b) => a.localeCompare(b)));

  // BUCKETED, never exact: $123,456 -> "$120k" bucket, and the exact figure
  // appears nowhere in the token or the reply.
  expect(body.receipt.amountBucket).toBe("$120k");
  const decoded = Buffer.from(token.split(".")[1], "base64url").toString("utf8");
  expect(decoded).not.toContain(DEAL_M.total); // "123456" is not in the signed body
  expect(JSON.stringify(body)).not.toContain(DEAL_M.total);

  // The GET verb answers identically, so a shared ?token= link is checkable.
  const getRes = await page.request.get(`/api/receipts/verify?token=${encodeURIComponent(token)}`);
  expect((await getRes.json()).valid).toBe(true);

  // COUNTERFACTUAL: one altered character breaks the signature. Flip the last
  // hex digit of the MAC; a genuine receipt would still verify, this must not.
  const last = token.slice(-1);
  const flipped = token.slice(0, -1) + (last === "0" ? "1" : "0");
  expect(flipped).not.toBe(token);
  const tamperRes = await page.request.post("/api/receipts/verify", { data: { token: flipped } });
  const tamper = (await tamperRes.json()) as { valid: boolean; error?: string };
  expect(tamper.valid).toBe(false);
  expect(tamper.error).toBe("bad_signature");

  await signOut(page);
});

test("A2 a solo/claimed deal mints nothing: no affordance on the page, null from the mint path", async () => {
  await logIn(page, REC.handle);

  // The solo deal's page carries every other section but no receipt.
  await page.goto(`/deals/${dealSId}`);
  await expect(page.getByText("solo deal").first()).toBeVisible();
  await expect(page.getByText("Portable receipt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show token" })).toHaveCount(0);
  await signOut(page);

  // The mint path itself refuses an unattested tier. Same deal shape, tier
  // flipped: claimed mints null, co_attested mints a token. This is the guard
  // failing on purpose.
  const split = [
    { username: "aa", role: "reporter", status: "confirmed", confirmedAt: 1, shareUsd: 40_000 },
    { username: "bb", role: "participant", status: "confirmed", confirmedAt: 2, shareUsd: 10_000 },
  ];
  const base = {
    id: "unit-deal",
    buyerToken: "v2:deadbeef",
    buyerIsOther: false,
    totalUsd: 50_000,
    split,
  };
  const claimed = { ...base, tier: "claimed" } as unknown as DealDetail;
  const coAttested = { ...base, tier: "co_attested" } as unknown as DealDetail;
  expect(mintReceiptForDeal(claimed)).toBeNull();
  expect(receiptPayloadForDeal(claimed)).toBeNull();
  const minted = mintReceiptForDeal(coAttested);
  expect(minted).not.toBeNull();
  expect(minted).toMatch(new RegExp(`^${RECEIPT_PREFIX}\\.`));
  expect(receiptPayloadForDeal(coAttested)?.participants).toEqual(["aa", "bb"]);
});

/* --------------------------------------------------- B: MATCHING PRIORITY */

test("B recorded volume sorts a poster ahead of a newer record-empty one, and wears a bucketed chip", async () => {
  const rec = await askByTitle(REC_ASK.title);
  const empty = await askByTitle(EMPTY_ASK.title);

  // The record-empty ask is strictly NEWER: pure recency would rank it first.
  expect(empty.createdAt).toBeGreaterThan(rec.createdAt);

  // REC's recorded attested volume is positive; EMPTY's is zero. The chip REC
  // wears is exactly recordedVolumeChip(volume), bucketed, and EMPTY wears none.
  const c = db();
  const volRs = await c.execute({
    sql: `SELECT p.user_id AS uid, SUM(p.share_usd) AS vol
            FROM deal_participants p
           WHERE p.user_id IN (?, ?) AND p.status = 'confirmed' AND p.share_usd > 0
             AND EXISTS (SELECT 1 FROM deal_participants q
                          WHERE q.deal_id = p.deal_id AND q.role = 'participant'
                            AND q.status = 'confirmed')
           GROUP BY p.user_id`,
    args: [rec.posterId, empty.posterId],
  });
  c.close();
  const volume = new Map(volRs.rows.map((r) => [String(r.uid), Number(r.vol ?? 0)]));
  const recVol = volume.get(rec.posterId) ?? 0;
  const emptyVol = volume.get(empty.posterId) ?? 0;
  expect(recVol).toBeGreaterThan(0);
  expect(emptyVol).toBe(0);
  const recChip = recordedVolumeChip(recVol);
  expect(recChip).not.toBeNull();
  expect(recordedVolumeChip(emptyVol)).toBeNull();

  // The board renders REC's ask above EMPTY's, and both are present (the
  // record-empty poster is NOT hidden). Relative order only, robust to the
  // many other asks the shared DB carries.
  await logIn(page, EMPTY.handle);
  await page.goto("/");
  const rows = page.locator("ul.divide-y.divide-rule > li");
  await expect(rows.first()).toBeVisible();
  const texts = await rows.allInnerTexts();
  const recIdx = texts.findIndex((t) => t.includes(REC_ASK.title));
  const emptyIdx = texts.findIndex((t) => t.includes(EMPTY_ASK.title));
  expect(recIdx, "REC ask on board").toBeGreaterThanOrEqual(0);
  expect(emptyIdx, "record-empty ask still shown, not hidden").toBeGreaterThanOrEqual(0);
  expect(recIdx, "recorded-volume poster sorts ahead of the newer record-empty one").toBeLessThan(emptyIdx);

  // The chip is on REC's row, bucketed, and absent on EMPTY's row.
  const recRow = rows.filter({ hasText: REC_ASK.title });
  const emptyRow = rows.filter({ hasText: EMPTY_ASK.title });
  await expect(recRow.locator('[title^="Track record"]')).toHaveCount(1);
  await expect(recRow.getByText(recChip as string)).toBeVisible();
  await expect(emptyRow.locator('[title^="Track record"]')).toHaveCount(0);
  await signOut(page);

  // COUNTERFACTUAL, at the comparator: with the track-record key REC precedes
  // EMPTY; strip it (equal buckets) and pure recency (createdAt desc) reverses
  // them, since EMPTY is newer.
  const now = Date.now();
  const recP: PriorityInput = { createdAt: rec.createdAt, volumeUsd: recVol, evidenceBackedDeals: 0 };
  const emptyP: PriorityInput = { createdAt: empty.createdAt, volumeUsd: emptyVol, evidenceBackedDeals: 0 };
  expect(comparePriority(recP, emptyP, now)).toBeLessThan(0); // REC first, with volume
  const recFlat: PriorityInput = { ...recP, volumeUsd: 0 };
  expect(comparePriority(recFlat, emptyP, now)).toBeGreaterThan(0); // EMPTY first, record ignored
});

/* ------------------------------------------- C: TIER WEIGHT + SYBIL RULE */

test("C1 an evidence-committed dollar outranks a co-attested dollar of the same size", async () => {
  // Pure weight: identical $100k confirmed shares, evidence-committed counts
  // 1.0, co-attested 0.5. Same dollar, twice the standing.
  const evidenceRows = [
    { role: "reporter" as const, status: "confirmed" as const, evidenceHash: "a".repeat(64) },
    { role: "participant" as const, status: "confirmed" as const, evidenceHash: "b".repeat(64) },
  ];
  const coAttestedRows = [
    { role: "reporter" as const, status: "confirmed" as const, evidenceHash: null },
    { role: "participant" as const, status: "confirmed" as const, evidenceHash: null },
  ];
  expect(tierValueWeight(evidenceRows)).toBe(WEIGHT_EVIDENCE_COMMITTED);
  expect(tierValueWeight(coAttestedRows)).toBe(WEIGHT_CO_ATTESTED);
  expect(100_000 * tierValueWeight(evidenceRows)).toBe(100_000);
  expect(100_000 * tierValueWeight(coAttestedRows)).toBe(50_000);
  // COUNTERFACTUAL: the weights are genuinely different; the pre-feature code
  // counted every confirmed dollar at 1.0, which would tie these two.
  expect(WEIGHT_CO_ATTESTED).not.toBe(WEIGHT_EVIDENCE_COMMITTED);

  // Feature 1: a PAYMENT-PROVEN deal weights higher. A co-attested deal whose
  // exchange reached wire_credit_observed (a countersigned, un-reversed
  // WireCreditClaim) counts at the FULL evidence-committed weight, not the halved
  // co-attested one: a mutually-attested inbound wire credit is at least as
  // strong as a committed document hash. It reverts to 0.5 once the wire is
  // reversed (the caller passes wireObserved=false again).
  expect(tierValueWeight(coAttestedRows, true)).toBe(WEIGHT_EVIDENCE_COMMITTED);
  expect(100_000 * tierValueWeight(coAttestedRows, true)).toBe(100_000);
  expect(tierValueWeight(coAttestedRows, false)).toBe(WEIGHT_CO_ATTESTED);
  // COUNTERFACTUAL: wire_credit_observed only UPGRADES a dollar that already
  // counts; it never makes a non-counting dollar count. A deal with no confirmed
  // counterparty is worth zero even when observed, the same predicate the fee
  // fires on, so proving payment cannot conjure standing from an unconfirmed deal.
  const noConfirmedCounterparty = [
    { role: "reporter" as const, status: "confirmed" as const, evidenceHash: null },
    { role: "participant" as const, status: "pending" as const, evidenceHash: null },
  ];
  expect(tierValueWeight(noConfirmedCounterparty, true)).toBe(0);

  // Wired into the live leaderboard, where it FLIPS a real pair. quiet-ledger's
  // standing is mostly evidence-committed (1.0); granite-fox carries a
  // co-attested slice that is halved. Recompute both from raw rows.
  const expected = await weightedSelfValue(["quiet-ledger", "granite-fox"]);
  const q = expected.get("quiet-ledger")!;
  const g = expected.get("granite-fox")!;
  // With the tier weight, quiet-ledger's self value leads granite-fox's...
  expect(q.weighted).toBeGreaterThan(g.weighted);
  // ...while the raw, unweighted dollars would put granite-fox ahead.
  expect(g.raw).toBeGreaterThan(q.raw);

  await logIn(page, REC.handle);
  await page.goto("/leaderboard");
  await page.getByRole("button", { name: "To self" }).click();
  const order = await page.locator("tbody tr td:nth-child(2)").allInnerTexts();
  const qi = order.findIndex((t) => t.includes("quiet-ledger"));
  const gi = order.findIndex((t) => t.includes("granite-fox"));
  expect(qi).toBeGreaterThanOrEqual(0);
  expect(gi).toBeGreaterThanOrEqual(0);
  // The page ranks quiet-ledger above granite-fox: the tier weight, not raw
  // dollars, decided it.
  expect(qi).toBeLessThan(gi);
  await signOut(page);
});

test("C2 a within-subtree confirmation accrues the fee but earns zero collaborator / value credit", async () => {
  // Seed deal 5: cold-copy reports, its own inviter quiet-ledger confirms. They
  // share the non-root ancestor quiet-ledger within two hops, so the confirmer
  // is sybil-dependent on the reporter.
  const coldCopy = await userId("cold-copy");
  const quietLedger = await userId("quiet-ledger");

  const c = db();
  const [edgesRs, usersRs] = await Promise.all([
    c.execute(`SELECT user_id, inviter_id FROM invite_edges`),
    c.execute(`SELECT id, created_at FROM users`),
  ]);
  c.close();
  const parentOf = new Map<string, string>();
  for (const e of edgesRs.rows) parentOf.set(String(e.user_id), String(e.inviter_id));
  const graph: InviteGraph = { parentOf };
  expect(isSybilRelated(graph, coldCopy, quietLedger)).toBe(true);

  // The leaderboard withholds the reputation: cold-copy shows zero
  // collaborators and no value to others, though the confirmation is real.
  await logIn(page, REC.handle);
  await page.goto("/leaderboard");
  const row = page.locator("tbody tr").filter({ hasText: `@cold-copy` });
  await expect(row).toHaveCount(1);
  await expect(row.locator("td").nth(2)).toHaveText("0"); // collaborators
  await expect(row.locator("td").nth(3)).toHaveText("<$10k"); // to others
  await signOut(page);

  // COUNTERFACTUAL: without the discount, quiet-ledger's confirmed $30k share
  // would credit cold-copy 1 collaborator and $30k*0.5 -> "$20k" to others.
  // The discount is exactly what turns that into 0 / <$10k. Prove it flips at
  // the predicate, on the real seed graph.
  const createdAt = new Map<string, number>();
  const usersC = db();
  const ur = await usersC.execute(`SELECT id, created_at FROM users`);
  usersC.close();
  for (const u of ur.rows) createdAt.set(String(u.id), Number(u.created_at));
  const ctx: IndependenceContext = {
    graph,
    createdAt,
    confirmedPeers: new Map(), // young accounts: no independent history yet
    now: Date.now(),
  };
  expect(isDiscountedConfirmer(ctx, coldCopy, quietLedger)).toBe(true);

  // Yet the FEE still fires on that same deal: the confirmed shares are earning
  // events, so being sybil-dependent costs the fee and buys no standing.
  const events = await earningEventsFor([coldCopy, quietLedger]);
  const coldEvents = events.get(coldCopy) ?? [];
  const quietEvents = events.get(quietLedger) ?? [];
  const feeDeals = new Set([...coldEvents, ...quietEvents].map((e) => e.dealId));
  const dealsC = db();
  const deal5 = await dealsC.execute({
    sql: `SELECT id FROM deals WHERE reporter_id = ? ORDER BY created_at LIMIT 1`,
    args: [coldCopy],
  });
  dealsC.close();
  // The very deal whose confirmation the leaderboard discounted still bears a
  // fee-bearing earning event: the fee is owed, only the standing is withheld.
  expect(deal5.rows.length).toBe(1);
  expect(feeDeals.has(String(deal5.rows[0].id))).toBe(true);
  expect(coldEvents.length + quietEvents.length).toBeGreaterThan(0);
});

test("C3 independent history lifts the discount for the same sybil-dependent confirmer", async () => {
  const coldCopy = await userId("cold-copy");
  const quietLedger = await userId("quiet-ledger");
  const graniteFox = await userId("granite-fox");

  const c = db();
  const edgesRs = await c.execute(`SELECT user_id, inviter_id FROM invite_edges`);
  c.close();
  const parentOf = new Map<string, string>();
  for (const e of edgesRs.rows) parentOf.set(String(e.user_id), String(e.inviter_id));
  const graph: InviteGraph = { parentOf };

  // granite-fox is in the OTHER branch: a deal with it is genuine outside
  // history relative to cold-copy's cluster.
  expect(isSybilRelated(graph, coldCopy, graniteFox)).toBe(false);

  const base = {
    graph,
    now: Date.now(),
  };

  // Case 1 (young, no outside deal): discounted.
  const youngCtx: IndependenceContext = {
    ...base,
    createdAt: new Map([[quietLedger, base.now]]),
    confirmedPeers: new Map(),
  };
  expect(isDiscountedConfirmer(youngCtx, coldCopy, quietLedger)).toBe(true);

  // Case 2 (aged past the threshold AND a confirmed deal with an outsider):
  // the SAME sybil-dependent pair is no longer discounted.
  const agedCtx: IndependenceContext = {
    ...base,
    createdAt: new Map([[quietLedger, base.now - (INDEPENDENCE_MIN_AGE_MS + 1)]]),
    confirmedPeers: new Map([[quietLedger, [[graniteFox]]]]),
  };
  expect(isDiscountedConfirmer(agedCtx, coldCopy, quietLedger)).toBe(false);

  // Guard the guard: age alone, with no outside deal, is not enough.
  const agedNoDeal: IndependenceContext = {
    ...base,
    createdAt: new Map([[quietLedger, base.now - (INDEPENDENCE_MIN_AGE_MS + 1)]]),
    confirmedPeers: new Map([[quietLedger, [[coldCopy]]]]), // only an in-cluster deal
  };
  expect(isDiscountedConfirmer(agedNoDeal, coldCopy, quietLedger)).toBe(true);
});

/* ---------------------------------------------------- D: OPERATOR SIGNALS */

test("D /api/admin/signals returns the three ranked lists to an operator and denies everyone else", async ({ request }) => {
  // Signed out: the session gate (middleware.ts / lib/gate.ts) intercepts the
  // request before the route runs, since /api/admin/signals is not a public
  // path, and redirects to /gate. No signals ever reach a cookieless caller.
  const anon = await request.get("/api/admin/signals", { maxRedirects: 0 });
  expect([301, 302, 303, 307, 308]).toContain(anon.status());
  expect(anon.headers()["location"] ?? "").toContain("/gate");

  // A signed-in NON-operator -> 403, same body, so the surface is not confirmed.
  await logIn(page, EMPTY.handle);
  const denied = await page.request.get("/api/admin/signals");
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error).toBe("Not found.");
  await signOut(page);

  // The operator (seeded) gets all three signatures. The fixture constructed a
  // row for each: REC is a fee-sink (near-root, several deals) and a remainder
  // outlier (90% unallocated on DEAL_L); SOCK confirms only REC and nothing
  // else.
  await logIn(page, OPERATOR.username, OPERATOR.password);
  const res = await page.request.get("/api/admin/signals?limit=50");
  expect(res.status()).toBe(200);
  const { signals } = (await res.json()) as {
    signals: {
      feeSink: { username: string; dealsNamedOn: number; recordedShareBucket: string; ancestorDepth: number }[];
      sock: { username: string; confirmations: number; soleReporterUsername: string }[];
      remainderOutlier: { username: string; unallocatedRatioBps: number; reportedDeals: number }[];
    };
  };

  expect(signals.feeSink.length).toBeGreaterThan(0);
  expect(signals.sock.length).toBeGreaterThan(0);
  expect(signals.remainderOutlier.length).toBeGreaterThan(0);

  // Each constructed row is present. (feeSink is always populated by the seed's
  // near-root reporters; SOCK and REC are the rows this fixture constructed.)
  const sockRow = signals.sock.find((r) => r.username === SOCK.handle);
  expect(sockRow, "SOCK on the sock list").toBeTruthy();
  expect(sockRow!.soleReporterUsername).toBe(REC.handle);
  const remRow = signals.remainderOutlier.find((r) => r.username === REC.handle);
  expect(remRow, "REC on the remainder list").toBeTruthy();
  expect(remRow!.unallocatedRatioBps).toBeGreaterThanOrEqual(5000);

  // Ranked lists: each is in non-increasing order of its documented sort key.
  // (feeSink's primary key is the exact volume the API never exposes, so it is
  // checked for presence, not order, here.)
  expectNonIncreasing(signals.sock.map((r) => r.confirmations));
  expectNonIncreasing(signals.remainderOutlier.map((r) => r.unallocatedRatioBps));

  await signOut(page);
});

/* ------------------------------------------------------------- PRIVACY */

test("PRIVACY new tables are metadata-only; receipts and signals carry only buckets and public handles", async () => {
  // Every live table is declared in the committed db/schema.sql. The party-
  // signature and exchange features DID add tables (deal_receipt_signatures,
  // user_signing_keys, exchange_sessions, exchange_events), so this no longer
  // forbids a "receipt"/"signal" name outright; instead it proves those tables
  // are metadata-only: public key material, signatures and hashed commitments,
  // never a raw amount, a real name, or a contact.
  const c = db();
  const liveRs = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  );
  const live = new Set(liveRs.rows.map((r) => String(r.name)));
  const fs = await import("node:fs/promises");
  const schemaSql = await fs.readFile(path.join(ROOT, "db", "schema.sql"), "utf8");
  const declared = new Set(
    [...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]),
  );
  for (const name of live) {
    expect(declared.has(name), `unexpected table "${name}" not in db/schema.sql`).toBe(true);
  }
  // The tables the new features added hold no PII and no raw amount: scan every
  // value in each for the deal totals and the identities this suite created.
  const forbidden = [DEAL_L.total, DEAL_M.total, REC.realName, REC.contact];
  for (const table of [
    "deal_receipt_signatures",
    "user_signing_keys",
    "exchange_sessions",
    "exchange_events",
  ]) {
    if (!live.has(table)) continue;
    const rs = await c.execute(`SELECT * FROM "${table}"`);
    const dump = JSON.stringify(rs.rows);
    for (const marker of forbidden) {
      expect(dump.includes(marker), `"${marker}" persisted in ${table}`).toBe(false);
    }
  }
  c.close();

  // The receipts surface exposes the bucket, never the exact total, and no PII.
  await logIn(page, REC.handle);
  await page.goto(`/deals/${dealMId}`);
  await page.getByRole("button", { name: "Show token" }).click();
  const token = (await page.getByText(new RegExp(`^${RECEIPT_PREFIX}\\.`)).first().innerText()).trim();
  const decoded = Buffer.from(token.split(".")[1], "base64url").toString("utf8");
  expect(decoded).toContain("$120k");
  expect(decoded).not.toContain(DEAL_M.total);
  expect(decoded).not.toContain(REC.realName);
  expect(decoded).not.toContain(REC.contact);
  await signOut(page);

  // The signals surface: bucket strings and counts only. No exact deal total,
  // no real name, no contact anywhere in the payload.
  await logIn(page, OPERATOR.username, OPERATOR.password);
  const res = await page.request.get("/api/admin/signals?limit=50");
  const raw = await res.text();
  expect(raw).not.toContain(DEAL_L.total); // "200000"
  expect(raw).not.toContain(DEAL_M.total); // "123456"
  expect(raw).not.toContain(REC.realName);
  expect(raw).not.toContain(REC.contact);
  // Every fee-sink dollar figure is a bucket string, never a raw amount.
  const { signals } = JSON.parse(raw) as {
    signals: { feeSink: { recordedShareBucket: string }[] };
  };
  for (const r of signals.feeSink) {
    expect(r.recordedShareBucket).toMatch(/^(<\$10k|\$\d[\d.]*[kM])$/);
  }
  await signOut(page);
});

/* --------------------------------------------------------------- helpers */

/**
 * Self value per reporter, both tier-weighted (the way the leaderboard counts)
 * and raw (every confirmed dollar at 1.0, the pre-feature way), recomputed here
 * from deal_participants independently of lib/stats.ts.
 */
async function weightedSelfValue(
  usernames: string[],
): Promise<Map<string, { weighted: number; raw: number }>> {
  const c = db();
  const rows = (
    await c.execute(
      `SELECT p.deal_id, p.user_id, p.role, p.share_usd, p.status, p.evidence_hash, u.username
         FROM deal_participants p JOIN users u ON u.id = p.user_id`,
    )
  ).rows;
  c.close();

  const byDeal = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = String(r.deal_id);
    const list = byDeal.get(k) ?? [];
    list.push(r);
    byDeal.set(k, list);
  }
  const want = new Set(usernames);
  const out = new Map<string, { weighted: number; raw: number }>();
  for (const u of usernames) out.set(u, { weighted: 0, raw: 0 });

  for (const dealRows of byDeal.values()) {
    const named = dealRows.filter((r) => String(r.role) === "participant");
    const confirmedNamed = named.filter((r) => String(r.status) === "confirmed");
    if (confirmedNamed.length === 0) continue; // nothing counts on this deal
    const anyPending = named.some((r) => String(r.status) === "pending");
    const reporter = dealRows.find((r) => String(r.role) === "reporter")!;
    const evidenceCommitted =
      !anyPending &&
      Boolean(reporter.evidence_hash) &&
      confirmedNamed.every((r) => Boolean(r.evidence_hash));
    const weight = evidenceCommitted ? 1.0 : 0.5;

    // Reporter's own share, once co-signed.
    const repName = String(reporter.username);
    if (want.has(repName)) {
      const acc = out.get(repName)!;
      acc.weighted += Number(reporter.share_usd) * weight;
      acc.raw += Number(reporter.share_usd);
    }
    // Each confirmed participant's own share.
    for (const p of confirmedNamed) {
      const name = String(p.username);
      if (!want.has(name)) continue;
      const acc = out.get(name)!;
      acc.weighted += Number(p.share_usd) * weight;
      acc.raw += Number(p.share_usd);
    }
  }
  return out;
}

function expectNonIncreasing(xs: number[]) {
  for (let i = 1; i < xs.length; i++) {
    expect(xs[i - 1] >= xs[i], `ranked descending at index ${i}: ${xs[i - 1]} < ${xs[i]}`).toBe(true);
  }
}

/* =====================================================================
 * BUILDER 2 mechanisms (A fee credit, B certificate, C standing, D board).
 * The end-to-end wiring of D is proven in tests/deals.spec.ts (the default
 * leaderboard column is now value-to-others); B's mint-nothing-for-solo is
 * proven in A2 above. These add the exact-rule guards for the new levers,
 * each with a counterfactual the pre-change code would have failed.
 * ===================================================================== */

test("E1 timely-recording credit fires only on a timely, evidenced deal, and only lowers", () => {
  const t = 1_700_000_000_000;
  // No stated close date at all: no credit, whatever the evidence.
  expect(recordingCreditBps(null, null, true)).toBe(0);
  expect(recordingCreditBps(t, null, true)).toBe(0);
  // Timely but no evidence committed by the earner: no credit.
  expect(recordingCreditBps(t, t, false)).toBe(0);
  // Timely AND evidenced: the full credit.
  expect(recordingCreditBps(t, t, true)).toBe(TIMELY_EVIDENCE_CREDIT_BPS);
  // The window is symmetric and closed at the edge, open just past it.
  expect(recordingCreditBps(t, t + TIMELY_RECORDING_WINDOW_MS, true)).toBe(
    TIMELY_EVIDENCE_CREDIT_BPS,
  );
  expect(recordingCreditBps(t, t - TIMELY_RECORDING_WINDOW_MS, true)).toBe(
    TIMELY_EVIDENCE_CREDIT_BPS,
  );
  expect(recordingCreditBps(t, t + TIMELY_RECORDING_WINDOW_MS + 1, true)).toBe(0);
  // A far-future close date cannot buy the credit by recording now.
  expect(recordingCreditBps(t, t + 400 * 24 * 60 * 60 * 1000, true)).toBe(0);

  // netAccrualCents: zero credit is exactly the gross accrual (the pre-feature
  // behaviour, which every deal without a close-date row keeps); the full
  // credit knocks 20% off and never goes below zero.
  const gross = accrualCents(60_000, 1); // $600 -> 150000c
  expect(netAccrualCents(60_000, 1, 0)).toBe(gross);
  expect(netAccrualCents(60_000, 1, TIMELY_EVIDENCE_CREDIT_BPS)).toBe(
    gross - Math.floor(gross * (TIMELY_EVIDENCE_CREDIT_BPS / 10000)),
  );
  expect(netAccrualCents(60_000, 1, TIMELY_EVIDENCE_CREDIT_BPS)).toBeLessThan(gross);
  expect(netAccrualCents(0, 1, TIMELY_EVIDENCE_CREDIT_BPS)).toBe(0);
  // COUNTERFACTUAL: a share the pre-feature code charged 150000c is charged
  // 120000c once it is timely and evidenced. The two are genuinely different.
  expect(netAccrualCents(60_000, 1, TIMELY_EVIDENCE_CREDIT_BPS)).not.toBe(gross);
});

test("E2 the credit flows through earningEventsFor and the ledger on a real deal (restored)", async () => {
  const recId = await userId(REC.handle);
  const c = db();
  const createdRs = await c.execute({
    sql: `SELECT created_at FROM deals WHERE id = ?`,
    args: [dealMId],
  });
  const recordedAt = Number(createdRs.rows[0].created_at);
  try {
    // A stated close date equal to the recorded_at is trivially timely.
    await c.execute({
      sql: `INSERT INTO deal_close_dates (deal_id, stated_close_at, recorded_at)
            VALUES (?, ?, ?)`,
      args: [dealMId, recordedAt, recordedAt],
    });
    // Timely, but REC has committed no evidence yet: still no credit.
    const before = (await earningEventsFor([recId])).get(recId) ?? [];
    const evBefore = before.find((e) => e.dealId === dealMId);
    expect(evBefore, "REC has a DEAL_M earning event").toBeTruthy();
    expect(evBefore!.creditBps).toBe(0);

    // REC commits evidence on their own reporter row -> now timely AND evidenced.
    await c.execute({
      sql: `UPDATE deal_participants SET evidence_hash = ?
             WHERE deal_id = ? AND user_id = ?`,
      args: ["a".repeat(64), dealMId, recId],
    });
    const after = (await earningEventsFor([recId])).get(recId) ?? [];
    const evAfter = after.find((e) => e.dealId === dealMId);
    expect(evAfter!.creditBps).toBe(TIMELY_EVIDENCE_CREDIT_BPS);
    // DEAL_L (no close-date row) is untouched: the credit is per-deal.
    for (const e of after) {
      if (e.dealId !== dealMId) expect(e.creditBps).toBe(0);
    }

    // The ledger charges the net: DEAL_M's depth-1 accrual drops 20% ($60k
    // share -> 150000c gross -> 30000c credited).
    const ledger = await computeReferralLedger(recId);
    const d1 = ledger.upline.find((u) => u.depth === 1);
    expect(d1, "REC has a depth-1 ancestor").toBeTruthy();
    expect(d1!.creditedCents).toBe(
      accrualCents(60_000, 1) - netAccrualCents(60_000, 1, TIMELY_EVIDENCE_CREDIT_BPS),
    );
    expect(d1!.creditedCents).toBe(30_000);
  } finally {
    // Restore DEAL_M so downstream suites see it exactly as they seeded it.
    await c.execute({ sql: `DELETE FROM deal_close_dates WHERE deal_id = ?`, args: [dealMId] });
    await c.execute({
      sql: `UPDATE deal_participants SET evidence_hash = NULL
             WHERE deal_id = ? AND user_id = ?`,
      args: [dealMId, recId],
    });
    c.close();
  }
});

test("E3 recorder standing tiers gate the badge and grow the invite cap", () => {
  const BUCKETS = RECORDED_VOLUME_BUCKETS;
  // Record-empty: tier 0, no chip, not trusted, base invite cap.
  const empty = recorderStanding(0, 0);
  expect(empty.tier).toBe(0);
  expect(empty.chip).toBeNull();
  expect(empty.trusted).toBe(false);
  expect(maxUnusedInvites(empty.tier)).toBe(MAX_UNUSED_INVITES);

  // Volume without evidence lifts the tier but not to trusted here.
  const mid = recorderStanding(BUCKETS[1], 0); // $50k, base bucket 2
  expect(mid.tier).toBe(2);
  expect(mid.trusted).toBe(false);
  expect(maxUnusedInvites(mid.tier)).toBe(MAX_UNUSED_INVITES + 2);

  // Evidence lifts the SAME volume one rung, over the trusted threshold.
  const evidenced = recorderStanding(BUCKETS[1], 1);
  expect(evidenced.tier).toBe(3);
  expect(evidenced.tier).toBeGreaterThanOrEqual(TRUSTED_RECORDER_MIN_TIER);
  expect(evidenced.trusted).toBe(true);
  // COUNTERFACTUAL: the same $50k without evidence is NOT trusted; the evidence
  // is exactly what flips the badge on.
  expect(recorderStanding(BUCKETS[1], 0).trusted).toBe(false);

  // The invite bonus is capped, and tier 0 never changes the base (so the
  // invites CAP spec's fresh account still holds exactly 5).
  expect(maxUnusedInvites(0)).toBe(MAX_UNUSED_INVITES);
  expect(maxUnusedInvites(99)).toBe(MAX_UNUSED_INVITES + MAX_STANDING_INVITE_BONUS);
  expect(maxUnusedInvites(1)).toBeGreaterThan(maxUnusedInvites(0));
});

test("E4 the engagement certificate provenance line reads as a track record, dated, no exact figure", () => {
  expect(CERTIFICATE_DISPUTE_WINDOW_DAYS).toBeGreaterThan(0);
  // A date, never a time.
  expect(certificateDate(Date.UTC(2026, 7, 20, 13, 45))).toBe("2026-08-20");

  const line = provenanceLine({
    tier: "co_attested",
    buyerShort: "2cee",
    buyerIsOther: false,
    amountBucket: "$120k",
    participants: ["aa", "bb"],
    attestedAt: Date.UTC(2026, 7, 20),
  });
  expect(line).toContain("co-attested");
  expect(line).toContain("Buyer #2cee");
  expect(line).toContain("$120k");
  expect(line).toContain("@aa, @bb");
  expect(line).toContain("2026-08-20");
  // Off-list buyers are marked; the bucket, not any exact figure, is all it carries.
  const off = provenanceLine({
    tier: "evidence_committed",
    buyerShort: "9f0a",
    buyerIsOther: true,
    amountBucket: "$1.5M",
    participants: ["cc"],
    attestedAt: Date.UTC(2026, 0, 2),
  });
  expect(off).toContain("evidence-committed");
  expect(off).toContain("(off-list)");
  expect(off).not.toContain("123456");
});
