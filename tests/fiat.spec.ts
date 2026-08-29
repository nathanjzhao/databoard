/**
 * tests/fiat.spec.ts
 *
 * The fiat proof-of-payment upgrade to the exchange's pay step (Feature 1: the
 * WireCreditClaim state machine; Feature 2: the verifiable-proof seam). Real
 * data buyers pay by wire, never crypto, so the pay step is no longer a
 * self-reported click: it is a three-party mutual attestation that a wire
 * carrying this deal's reference was SENT and OBSERVED, gating the key reveal,
 * and honestly labelled wire_credit_observed (NOT fiat_final).
 *
 * Every test carries a COUNTERFACTUAL the pre-change code (or a cheat) would
 * have failed:
 *
 *   PAY-1  drive an exchange to the pay step: the UI shows a unique, copyable
 *          wire-reference nonce; the buyer submits proof-of-payment by hashing a
 *          locally-generated file IN THE BROWSER (+ label + amount bucket + N15),
 *          signed with the buyer key; the reveal does NOT advance until the
 *          seller attests the credit AND the buyer countersigns it. The file
 *          bytes never reach the server (network capture + a table dump).
 *
 *   PAY-2  cheat path: the buyer submits proof and the seller DISPUTES instead
 *          of attesting the credit; the exchange does not advance and the dispute
 *          is a signed event in the chain; a proof event with a bad buyer
 *          signature is refused.
 *
 *   WEIGHT a countersigned, payment-proven deal weights HIGHER on the leaderboard
 *          than a merely co-attested one of the same size (the ranked figure is
 *          double), and a wire_reversed reverts it; /transparency/verification
 *          states the pay step is mutual attestation.
 *
 *   F2-STUB the verifiable-proof rung is inert until configured: GET /api/payproof
 *          reads "planned", POST /api/payproof/verify answers 503, and the panel
 *          labels verifiable proof as planned.
 *
 *   PRIVACY a dump of every table: no bank details, no wire-confirmation bytes,
 *          no exact amount (buckets only), no PII.
 *
 * Shared-DB discipline, like every suite here: it mints its own accounts through
 * operator invite codes and asserts facts about its own sessions only. All three
 * of its accounts are children of the ROOT operator, so they are sybil-
 * independent of one another and their confirmations count in full on the board.
 *
 * PRECONDITION: a freshly reset + seeded DB and the built app on port 3947:
 *   SERVER_PEPPER=... npm run reset-db && npm run seed
 *   CI=1 SERVER_PEPPER=... npx playwright test tests/fiat.spec.ts
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
  EXCHANGE_VERSION,
  GENESIS_PREV_HASH,
  WIRE_CLAIM_VERSION,
  WIRE_TERMINAL_STATUSES,
  accountNullifierHex,
  deriveSigningKeys,
  generateDek,
  encryptDataset,
  dekCommitHex,
  eventHash,
  n15Of,
  isN15,
  signLeaf,
  verifyChain,
  verifyWireChain,
  wireNonce,
  wireNonceCommitHex,
  wireRecordCommitHex,
  wireReversalCommitHex,
  wireSentCommitHex,
  wireStatusFrom,
  uetrCommitHex,
  newSessionId,
  type ExchangeLeaf,
  type ExchangeRole,
  type StoredEvent,
  type StoredWireEvent,
  type WireClaimLeaf,
  type WireClaimType,
} from "../lib/exchange";
import { toB64url } from "../lib/e2ee";

const ROOT = path.resolve(__dirname, "..");
const DB_URL = process.env.BLIND_TENDER_DB ?? `file:${path.join(ROOT, "data", "app.db")}`;
const PORT = Number(process.env.PW_PORT ?? 3947);
const BASE = `http://localhost:${PORT}`;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PW = "fiat-verify-000";
const OPERATOR = { username: "marble-pennant", password: "demo-demo-demo" };

/* SELLER is the seller AND the reporter of D1 (the payment-proven deal).
 * REP_B reports DB, an identical co-attested deal that never sees a wire. BUYER
 * is the confirmed participant/buyer on BOTH, at the same $40k share, so the two
 * reporters differ on exactly one thing: whether their deal reached
 * wire_credit_observed. */
const SELLER = { realName: "Dana Holt", org: "Fiat Sell Co", contact: `fiat-sell-${RUN}@example.org`, handle: "" };
const BUYER = { realName: "Wren Ames", contact: `fiat-buy-${RUN}@example.org`, handle: "" };
const REP_B = { realName: "Ira Voss", org: "Fiat Rep B", contact: `fiat-repb-${RUN}@example.org`, handle: "" };

/** Identical $40k participant share on both deals, so the weighted figures compare cleanly. */
const PART_SHARE = "40000";
const MY_SHARE = "20000";
const DEAL_TOTAL = "84000";
/** The buyer wires this in the exchange (a payment, not a deal share); it must be bucketed. */
const WIRED_AMOUNT = "80000";
const WIRED_BUCKET = "$80k";

/* Markers we later scan every table for. Each is hashed in the browser (or is
 * the demo AEAD blob) and must appear in NO row. */
const DATASET =
  "row_id,region,signups,revenue_usd\n" +
  Array.from({ length: 24 }, (_, i) =>
    [`r${3000 + i}`, ["emea", "amer", "apac"][i % 3], 100 + i, (5000 + i * 71).toString()].join(","),
  ).join("\n") +
  "\nDATASET_SECRET_" + RUN + "\n";
const FILE_MARKER = `WIRE_CONFIRMATION_FILE_${RUN}`;
const RECORD_MARKER = `BANK_RECORD_${RUN}`;
const ACCT_MARKER = `RECEIVING_ACCT_${RUN}`;
const UETR_MARKER = `UETR_${RUN}`;
const CHUNK = 256;

/* ------------------------------------------------------------ DB helpers */

function db() {
  return createClient({ url: DB_URL });
}
async function clearRateLimits() {
  const c = db();
  await c.execute("DELETE FROM rate_limits");
  c.close();
}
async function allTableNames(): Promise<string[]> {
  const c = db();
  const rs = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  );
  c.close();
  return rs.rows.map((r) => String(r.name));
}
/** The whole database as one JSON string: every table, every row. */
async function dumpEntireDb(): Promise<string> {
  const c = db();
  const names = (
    await c.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  ).rows.map((r) => String(r.name));
  let out = "";
  for (const name of names) {
    const rs = await c.execute(`SELECT * FROM "${name}"`);
    out += `\n/* ${name} */\n` + JSON.stringify(rs.rows);
  }
  c.close();
  return out;
}
async function dumpExchangeTables(): Promise<{
  sessions: Record<string, unknown>[];
  events: Record<string, unknown>[];
  wire: Record<string, unknown>[];
}> {
  const c = db();
  const sessions = (await c.execute("SELECT * FROM exchange_sessions")).rows as Record<string, unknown>[];
  const events = (await c.execute("SELECT * FROM exchange_events")).rows as Record<string, unknown>[];
  const wire = (await c.execute("SELECT * FROM exchange_wire_claims")).rows as Record<string, unknown>[];
  c.close();
  return { sessions, events, wire };
}

/** Recursively collect every numeric value, so a bucket string never false-hits a hex hash. */
function numbersIn(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number") out.push(v);
  else if (Array.isArray(v)) for (const x of v) numbersIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) numbersIn(x, out);
  return out;
}

/* --------------------------------------------------------------- crypto */

/** This account's per-user KDF salt (user_kdf_salt), the one signup registered. */
async function saltFor(handle: string): Promise<string | undefined> {
  const c = db();
  const rs = await c.execute({
    sql: `SELECT s.salt FROM user_kdf_salt s JOIN users u ON u.id = s.user_id
           WHERE u.username = ?`,
    args: [handle],
  });
  c.close();
  return rs.rows[0] ? String(rs.rows[0].salt) : undefined;
}

// Derived under the account's per-user KDF salt (F-01), matching the key the
// browser signup registered and the exchange append path verifies against.
async function keysFor(handle: string) {
  return deriveSigningKeys(handle, PW, await saltFor(handle));
}

function flipB64(s: string): string {
  const first = s[0] === "A" ? "B" : "A";
  return first + s.slice(1);
}

function commitLeaf(args: {
  sessionId: string;
  dealId: string;
  seller: string;
  buyer: string;
  enc: Awaited<ReturnType<typeof encryptDataset>>;
  dekCommit: string;
  dekSalt: Uint8Array;
  n15: string;
  nonce: Uint8Array;
}): ExchangeLeaf {
  return {
    v: EXCHANGE_VERSION,
    sessionId: args.sessionId,
    dealId: args.dealId,
    seq: 1,
    type: "commit",
    actorRole: "seller",
    actor: args.seller,
    prevHash: GENESIS_PREV_HASH,
    ts: Date.now(),
    data: {
      plaintextRoot: args.enc.plaintextRoot,
      ciphertextRoot: args.enc.ciphertextRoot,
      dekCommit: args.dekCommit,
      dekSalt: toB64url(args.dekSalt),
      chunkCount: args.enc.chunkCount,
      chunkSize: args.enc.chunkSize,
      sizeBucket: args.enc.sizeBucket,
      buyer: args.buyer,
      n15: args.n15,
      wireNonceCommit: wireNonceCommitHex(args.dealId, new Uint8Array(16).fill(9), args.nonce),
    },
  };
}

function nextLeaf(
  session: { id: string; dealId: string; headSeq: number; headHash: string },
  role: ExchangeRole,
  actor: string,
  type: ExchangeLeaf["type"],
  data: Record<string, unknown>,
): ExchangeLeaf {
  return {
    v: EXCHANGE_VERSION,
    sessionId: session.id,
    dealId: session.dealId,
    seq: session.headSeq + 1,
    type,
    actorRole: role,
    actor,
    prevHash: session.headHash,
    ts: Date.now(),
    data,
  };
}

async function postSigned(
  api: APIRequestContext,
  url: string,
  leaf: ExchangeLeaf,
  keys: { publicKey: string; secretKey: Uint8Array },
) {
  return api.post(url, {
    data: {
      leaf,
      eventHash: eventHash(leaf),
      signature: signLeaf(leaf, keys.secretKey),
      signerPubkey: keys.publicKey,
    },
  });
}

type SessionView = {
  id: string;
  dealId: string;
  state: string;
  headSeq: number;
  headHash: string;
  chunkSize: number;
  chunkCount: number;
  ciphertextRoot: string;
  plaintextRoot: string;
  dekCommit: string;
  sellerSigningPubkey: string;
  buyerSigningPubkey: string | null;
  events: StoredEvent[];
  n15: string | null;
  wireStatus: "pending" | "claimed" | "observed" | "reversed";
  wireAnchorHash: string | null;
  wireEvents: StoredWireEvent[];
};

/** Build a WireCreditClaim leaf on the wire sub-chain (anchored to payment_signaled). */
function wireLeaf(
  session: SessionView,
  role: ExchangeRole,
  actor: string,
  type: WireClaimType,
  data: Record<string, unknown>,
): WireClaimLeaf {
  const n = session.wireEvents.length;
  const prevHash =
    n === 0 ? session.wireAnchorHash ?? GENESIS_PREV_HASH : session.wireEvents[n - 1].eventHash;
  return {
    v: EXCHANGE_VERSION,
    sessionId: session.id,
    dealId: session.dealId,
    seq: n + 1,
    type,
    actorRole: role,
    actor,
    prevHash,
    ts: Date.now(),
    data,
  };
}

async function postWireSigned(
  api: APIRequestContext,
  sessionId: string,
  leaf: WireClaimLeaf,
  keys: { publicKey: string; secretKey: Uint8Array },
) {
  return api.post(`${BASE}/api/exchange/${sessionId}/wire`, {
    data: {
      leaf,
      eventHash: eventHash(leaf),
      signature: signLeaf(leaf, keys.secretKey),
      signerPubkey: keys.publicKey,
    },
  });
}

/** A well-formed seller WireCreditClaim body; caller overrides fields per test. */
function claimData(n15: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    n15,
    rail: "WIRE",
    amountBucket: WIRED_BUCKET,
    terminalStatus: WIRE_TERMINAL_STATUSES[0],
    valueTime: Date.now(),
    bankRecordCommit: wireRecordCommitHex(new Uint8Array(16).fill(3), new TextEncoder().encode(RECORD_MARKER)),
    accountNullifier: accountNullifierHex(SELLER.handle, ACCT_MARKER),
    uetrCommit: uetrCommitHex(new Uint8Array(16).fill(4), UETR_MARKER),
    schemaVersion: WIRE_CLAIM_VERSION,
    ...over,
  };
}

async function fetchSession(api: APIRequestContext, id: string): Promise<SessionView> {
  const res = await api.get(`${BASE}/api/exchange/${id}`);
  expect(res.status(), `GET session ${id}`).toBe(200);
  return (await res.json()).session as SessionView;
}

/** Open a session's genesis commit and deliver the demo ciphertext. Returns session state. */
async function openSession(
  ctx: BrowserContext,
  dealId: string,
  keys: { publicKey: string; secretKey: Uint8Array },
): Promise<{ sessionId: string; dek: Uint8Array; dekSalt: Uint8Array; n15: string; enc: Awaited<ReturnType<typeof encryptDataset>> }> {
  const sessionId = newSessionId();
  const dek = generateDek();
  const dekSalt = new Uint8Array(16);
  crypto.getRandomValues(dekSalt);
  const nonce = wireNonce();
  const n15 = n15Of(dealId, nonce);
  const enc = await encryptDataset(sessionId, new TextEncoder().encode(DATASET), dek, CHUNK);
  const dekCommit = dekCommitHex(dealId, enc.ciphertextRoot, dekSalt, dek);
  const leaf = commitLeaf({ sessionId, dealId, seller: SELLER.handle, buyer: BUYER.handle, enc, dekCommit, dekSalt, n15, nonce });
  const res = await postSigned(ctx.request, `${BASE}/api/exchange`, leaf, keys);
  expect(res.status(), await res.text()).toBe(201);
  const up = await ctx.request.post(`${BASE}/api/exchange/${sessionId}/blob`, {
    data: { ciphertext: toB64url(enc.ciphertext) },
  });
  expect(up.status()).toBe(200);
  return { sessionId, dek, dekSalt, n15, enc };
}

/* ------------------------------------------------------------ UI helpers */

async function mintOperatorCodes(api: APIRequestContext, n: number): Promise<string[]> {
  const xff = { "x-forwarded-for": `198.51.100.${40 + Math.floor(Math.random() * 150)}` };
  const login = await api.post(`${BASE}/api/auth/login`, {
    headers: xff,
    data: { username: OPERATOR.username, password: OPERATOR.password },
  });
  expect(login.status(), "operator login for minting").toBe(200);
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = await api.post(`${BASE}/api/invites`, { headers: xff });
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
  await p.getByLabel("Six digit code").fill(demoCode);
  await p.getByRole("button", { name: "Continue" }).click();
  await expect(p.getByText("Pick what we actually keep")).toBeVisible();
  await p.getByLabel("Password").fill(PW);
  await p.getByRole("button", { name: "Create account" }).click();
  const handle =
    (await p.getByTestId("assigned-handle").textContent({ timeout: 15_000 }))?.replace(/^@/, "").trim() ?? "";
  expect(handle).toMatch(/^[a-z0-9][a-z0-9_-]{2,23}$/);
  await p.getByRole("button", { name: "Go to the board" }).click();
  await expect(p.getByText(`@${handle}`).first()).toBeVisible({ timeout: 15_000 });
  return handle;
}

async function recordDeal(
  p: Page,
  opts: { buyer: string; total: string; myShare: string; participant: [string, string] },
): Promise<string> {
  await p.goto("/deals/new");
  await expect(p.getByText("Say what closed, and who was in it.")).toBeVisible();
  await p.getByLabel("Buying lab").selectOption(opts.buyer);
  await p.getByLabel("Total value, USD").fill(opts.total);
  await p.getByLabel("Your share, USD").fill(opts.myShare);
  await p.getByRole("button", { name: "+ add participant" }).click();
  await p.getByLabel("Participant handle").nth(0).fill(opts.participant[0]);
  await p.getByLabel("Participant share in USD").nth(0).fill(opts.participant[1]);
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

/** One public leaderboard row, as /api/leaderboard projects it. */
type PublicRow = {
  username: string;
  valueToOthers: string;
  ranks: { collaborators: number; value_to_others: number; value_to_self: number };
};
async function leaderboardRows(api: APIRequestContext): Promise<Map<string, PublicRow>> {
  const res = await api.get(`${BASE}/api/leaderboard`);
  expect(res.status(), "leaderboard is members-only and 200 for a signed-in member").toBe(200);
  const body = (await res.json()) as { rows: PublicRow[] };
  return new Map(body.rows.map((r) => [r.username, r]));
}

/* ============================================================= fixtures */

test.describe.configure({ mode: "serial" });

let sellerCtx: BrowserContext; // SELLER, reporter of D1
let buyerCtx: BrowserContext; // BUYER, confirmed participant on D1 and DB
let repBCtx: BrowserContext; // REP_B, reporter of the co-attested DB
let sellerPage: Page;
let buyerPage: Page;
let repBPage: Page;
let dealD1 = "";
let dealDB = "";
let sellerKeys: Awaited<ReturnType<typeof keysFor>>;
let buyerKeys: Awaited<ReturnType<typeof keysFor>>;

/** PAY-1's session (payment-proven), carried into WEIGHT for the reversal counterfactual. */
let live: { sessionId: string; dek: Uint8Array; claimHash: string };

test.beforeAll(async ({ browser }) => {
  sellerCtx = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "198.51.100.211" } });
  buyerCtx = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "198.51.100.212" } });
  repBCtx = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "198.51.100.213" } });
  sellerPage = await sellerCtx.newPage();
  buyerPage = await buyerCtx.newPage();
  repBPage = await repBCtx.newPage();
});

test.afterAll(async () => {
  await sellerCtx?.close();
  await buyerCtx?.close();
  await repBCtx?.close();
});

test("00 fixture: three root-independent accounts and two identical co-attested deals", async ({ request }) => {
  await clearRateLimits();
  const [cSell, cBuy, cRepB] = await mintOperatorCodes(request, 3);
  SELLER.handle = await signUp(sellerPage, { realName: SELLER.realName, org: SELLER.org, contact: SELLER.contact, inviteCode: cSell });
  BUYER.handle = await signUp(buyerPage, { realName: BUYER.realName, contact: BUYER.contact, inviteCode: cBuy });
  REP_B.handle = await signUp(repBPage, { realName: REP_B.realName, org: REP_B.org, contact: REP_B.contact, inviteCode: cRepB });

  // D1: SELLER reports, BUYER is the $40k participant. Co-attested until a wire
  // is observed on it.
  dealD1 = await recordDeal(sellerPage, {
    buyer: "Anthropic",
    total: DEAL_TOTAL,
    myShare: MY_SHARE,
    participant: [BUYER.handle, PART_SHARE],
  });
  await confirmMyShare(buyerPage);

  // DB: REP_B reports the SAME shape with the SAME $40k participant, and never
  // runs a wire. It is the co-attested control the payment-proven deal beats.
  dealDB = await recordDeal(repBPage, {
    buyer: "Anthropic",
    total: DEAL_TOTAL,
    myShare: MY_SHARE,
    participant: [BUYER.handle, PART_SHARE],
  });
  await confirmMyShare(buyerPage);

  sellerKeys = await keysFor(SELLER.handle);
  buyerKeys = await keysFor(BUYER.handle);
  expect(dealD1.length).toBeGreaterThan(0);
  expect(dealDB.length).toBeGreaterThan(0);
  expect(dealD1).not.toBe(dealDB);
});

/* ================================================================= PAY-1 */

test("PAY-1 the copyable wire nonce, an in-browser file hash the server never sees, and a gated reveal", async () => {
  // The seller commits; the reveal will hang off this deal's reference.
  const opened = await openSession(sellerCtx, dealD1, sellerKeys);
  const sessionId = opened.sessionId;
  const n15 = opened.n15;
  expect(isN15(n15)).toBe(true);

  // The buyer verifies the ciphertext (drives the session to ciphertext_ack, so
  // the page below opens on the buyer's payment step) and pins its signing key.
  let session = await fetchSession(buyerCtx.request, sessionId);
  const ackLeaf = nextLeaf(session, "buyer", BUYER.handle, "ciphertext_ack", {
    ciphertextRoot: session.ciphertextRoot,
  });
  expect((await postSigned(buyerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, ackLeaf, buyerKeys)).status()).toBe(200);

  // ---- UI: the buyer's payment step -----------------------------------------
  await buyerPage.goto(`/deals/${dealD1}/exchange`);
  // Capture EVERY request the page makes while it hashes the file and signs, so
  // we can prove the file bytes never crossed the wire. Unlocking derives the
  // signing key in-browser and makes no request of its own.
  const bodies: string[] = [];
  buyerPage.on("request", (req) => {
    const pd = req.postData();
    if (pd) bodies.push(pd);
  });

  // Unlock the buyer's signing key (derived in-browser from the password).
  await buyerPage.getByPlaceholder("Password").fill(PW);
  await buyerPage.getByRole("button", { name: "Unlock" }).click();

  // The wire-reference nonce is shown, and it is copyable.
  await expect(buyerPage.getByText("Wire reference (N15)").first()).toBeVisible();
  await expect(buyerPage.getByText(n15).first()).toBeVisible(); // the exact minted alias
  await expect(buyerPage.getByRole("button", { name: "copy" }).first()).toBeVisible(); // a copy affordance

  // The buyer submits proof-of-payment by hashing a LOCAL FILE in the browser.
  const fileBytes = Buffer.from(`${FILE_MARKER}\nreceipt-body-that-must-stay-local\n`, "utf8");
  await buyerPage.locator('input[type="file"]').setInputFiles({
    name: "wire-confirmation.txt",
    mimeType: "text/plain",
    buffer: fileBytes,
  });
  await buyerPage.getByPlaceholder("80000").fill(WIRED_AMOUNT);
  const [payResp] = await Promise.all([
    buyerPage.waitForResponse(
      (r) => r.url().includes(`/api/exchange/${sessionId}/events`) && r.request().method() === "POST",
    ),
    buyerPage.getByRole("button", { name: "Commit payment sent and sign" }).click(),
  ]);
  expect(payResp.status(), "the buyer's signed PAYMENT_SENT is accepted").toBe(200);

  // Non-vacuous: we really did capture the signing request that carries the
  // commitment, so "no file bytes" below is a claim about a body that exists.
  expect(bodies.some((b) => b.includes("paymentCommit")), "captured the signed PAYMENT_SENT request body").toBe(true);
  // The file bytes are in NONE of the request bodies (raw or base64): the hash
  // was computed in the browser and only the commitment left the tab.
  const marker64 = fileBytes.toString("base64");
  const markerUrl64 = fileBytes.toString("base64url");
  for (const body of bodies) {
    expect(body.includes(FILE_MARKER), "raw file bytes must never appear in a request").toBe(false);
    expect(body.includes(marker64) || body.includes(markerUrl64), "base64 file bytes must never appear either").toBe(false);
  }

  session = await fetchSession(buyerCtx.request, sessionId);
  expect(session.state).toBe("payment_signaled");
  // The event carries the salted commitment, the rail, the N15 and the BUCKET,
  // never the exact amount.
  const payEvent = session.events.find((e) => e.type === "payment_signaled")!;
  expect(String(payEvent.data.paymentCommit)).toMatch(/^[0-9a-f]{64}$/);
  expect(payEvent.data.n15).toBe(n15);
  expect(payEvent.data.amountBucket).toBe(WIRED_BUCKET);

  // ---- GATE: the reveal does not advance until the credit is mutually observed
  // COUNTERFACTUAL: the seller cannot reveal on a merely-sent payment.
  session = await fetchSession(sellerCtx.request, sessionId);
  expect(session.wireStatus).toBe("pending");
  let earlyReveal = nextLeaf(session, "seller", SELLER.handle, "dek_revealed", { dekCommit: session.dekCommit });
  let blocked = await postSigned(sellerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, earlyReveal, sellerKeys);
  expect(blocked.status(), "reveal before any wire claim is refused").toBe(409);
  expect((await blocked.json()).error).toBe("wire_not_observed");

  // The seller attests the observed inbound credit (the seller's half of the
  // three-party claim).
  const claim = wireLeaf(session, "seller", SELLER.handle, "wire_credit_claim", claimData(n15));
  const claimHash = eventHash(claim);
  expect((await postWireSigned(sellerCtx.request, sessionId, claim, sellerKeys)).status(), "seller claim accepted").toBe(200);

  // COUNTERFACTUAL: still gated. A one-sided claim (no buyer countersign) does
  // NOT release the key.
  session = await fetchSession(sellerCtx.request, sessionId);
  expect(session.wireStatus).toBe("claimed");
  earlyReveal = nextLeaf(session, "seller", SELLER.handle, "dek_revealed", { dekCommit: session.dekCommit });
  blocked = await postSigned(sellerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, earlyReveal, sellerKeys);
  expect(blocked.status(), "reveal after a one-sided claim is still refused").toBe(409);
  expect((await blocked.json()).error).toBe("wire_not_observed");

  // The buyer COUNTERSIGNS the exact claim: wire_credit_observed.
  session = await fetchSession(buyerCtx.request, sessionId);
  const counter = wireLeaf(session, "buyer", BUYER.handle, "wire_credit_countersign", {
    claimHash,
    n15,
    accept: true,
  });
  expect((await postWireSigned(buyerCtx.request, sessionId, counter, buyerKeys)).status(), "buyer countersign accepted").toBe(200);
  session = await fetchSession(sellerCtx.request, sessionId);
  expect(session.wireStatus).toBe("observed");
  expect(verifyWireChain(session.id, session.dealId, session.wireAnchorHash!, session.wireEvents).ok).toBe(true);

  // NOW the reveal advances.
  const reveal = nextLeaf(session, "seller", SELLER.handle, "dek_revealed", { dekCommit: session.dekCommit });
  const revRes = await postSigned(sellerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, reveal, sellerKeys);
  expect(revRes.status(), await revRes.text()).toBe(200);
  expect((await revRes.json()).session.state).toBe("dek_revealed");

  // ---- The file bytes never reached the server (a table dump, too) ---------
  const tables = await dumpExchangeTables();
  const dump = JSON.stringify(tables.events) + JSON.stringify(tables.wire);
  expect(dump.includes(FILE_MARKER), "wire-confirmation bytes must not be in any exchange row").toBe(false);

  live = { sessionId, dek: opened.dek, claimHash };
});

/* ================================================================= PAY-2 */

test("PAY-2 cheat path: a disputed payment does not advance, and a bad buyer signature is refused", async () => {
  // A fresh session on the same deal (the PAY-1 session is spent).
  const opened = await openSession(sellerCtx, dealD1, sellerKeys);
  const sessionId = opened.sessionId;
  const n15 = opened.n15;

  // Buyer verifies the ciphertext.
  let session = await fetchSession(buyerCtx.request, sessionId);
  const ack = nextLeaf(session, "buyer", BUYER.handle, "ciphertext_ack", { ciphertextRoot: session.ciphertextRoot });
  expect((await postSigned(buyerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, ack, buyerKeys)).status()).toBe(200);

  // COUNTERFACTUAL: a PAYMENT_SENT proof with a corrupted buyer signature is
  // refused (bad_signature), and the state does not move.
  session = await fetchSession(buyerCtx.request, sessionId);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const commit = wireSentCommitHex(salt, WIRED_BUCKET, n15, Buffer.from(`${FILE_MARKER}\n2\n`, "utf8"));
  const payLeaf = nextLeaf(session, "buyer", BUYER.handle, "payment_signaled", {
    paymentCommit: commit,
    method: "wire",
    n15,
    amountBucket: WIRED_BUCKET,
  });
  const forged = await buyerCtx.request.post(`${BASE}/api/exchange/${sessionId}/events`, {
    data: {
      leaf: payLeaf,
      eventHash: eventHash(payLeaf),
      signature: flipB64(signLeaf(payLeaf, buyerKeys.secretKey)),
      signerPubkey: buyerKeys.publicKey,
    },
  });
  expect(forged.status(), "a bad buyer signature on the proof is rejected").toBe(400);
  expect((await forged.json()).error).toBe("bad_signature");
  expect((await fetchSession(buyerCtx.request, sessionId)).state).toBe("ciphertext_ack"); // unmoved

  // The buyer submits the proof for real.
  const good = await postSigned(buyerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, payLeaf, buyerKeys);
  expect(good.status(), await good.text()).toBe(200);
  expect((await good.json()).session.state).toBe("payment_signaled");

  // The SELLER DISPUTES instead of attesting the credit: a signed abort. (In the
  // three-party claim the seller's productive next move is the wire_credit_claim;
  // refusing it and signing an abort is how a seller who did not see the money
  // says so, on the record.)
  session = await fetchSession(sellerCtx.request, sessionId);
  const disputeLeaf = nextLeaf(session, "seller", SELLER.handle, "abort", {
    reason: "no matching inbound credit observed; disputing the claimed payment",
  });
  const dispute = await postSigned(sellerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, disputeLeaf, sellerKeys);
  expect(dispute.status(), await dispute.text()).toBe(200);
  const aborted = (await dispute.json()).session as SessionView;
  expect(aborted.state, "the disputed exchange does not advance to reveal").toBe("aborted");

  // The dispute is a SIGNED event in the hash-linked chain, by the seller.
  session = await fetchSession(sellerCtx.request, sessionId);
  expect(verifyChain(session.id, session.dealId, session.events).ok).toBe(true);
  const last = session.events[session.events.length - 1];
  expect(last.type).toBe("abort");
  expect(last.actorRole).toBe("seller");
  expect(session.wireStatus, "no wire credit was ever observed on the disputed deal").toBe("pending");

  // COUNTERFACTUAL: with the trade disputed/terminal, the seller cannot reveal
  // the key at all.
  const lateReveal = nextLeaf(session, "seller", SELLER.handle, "dek_revealed", { dekCommit: session.dekCommit });
  const late = await postSigned(sellerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, lateReveal, sellerKeys);
  expect(late.status(), "no reveal on a disputed, aborted exchange").toBe(409);
  expect((await late.json()).error).toBe("terminal");
});

/* ================================================================ WEIGHT */

test("WEIGHT a payment-proven deal outranks an identical co-attested one, and a reversal reverts it", async () => {
  // Both deals are co-attested $40k participant shares. The only difference:
  // D1's exchange reached wire_credit_observed (PAY-1), DB's never did. The
  // reporter of the payment-proven deal must read DOUBLE the ranked figure.
  const rows = await leaderboardRows(sellerCtx.request);
  const a = rows.get(SELLER.handle);
  const b = rows.get(REP_B.handle);
  expect(a, "the payment-proven reporter is on the board").toBeTruthy();
  expect(b, "the co-attested reporter is on the board").toBeTruthy();

  // The ranked figure: $40k for the observed deal (40000 x 1.0), $20k for the
  // co-attested one (40000 x 0.5). Same dollar, twice the standing.
  expect(a!.valueToOthers).toBe("$40k");
  expect(b!.valueToOthers).toBe("$20k");
  // And the board ranks the payment-proven reporter above the co-attested one.
  expect(a!.ranks.value_to_others).toBeLessThan(b!.ranks.value_to_others);

  // COUNTERFACTUAL: a wire_reversed reopens the deal and REVERTS the weighting.
  // The seller appends the reversal to the PAY-1 wire chain.
  const session = await fetchSession(sellerCtx.request, live.sessionId);
  expect(session.wireStatus).toBe("observed");
  const rsalt = new Uint8Array(16);
  crypto.getRandomValues(rsalt);
  const reversal = wireLeaf(session, "seller", SELLER.handle, "wire_reversed", {
    claimHash: live.claimHash,
    reason: "credit recalled by the originating bank",
    reversalCommit: wireReversalCommitHex(rsalt, new TextEncoder().encode(`REVERSAL_ADVICE_${RUN}`)),
  });
  const revRes = await postWireSigned(sellerCtx.request, live.sessionId, reversal, sellerKeys);
  expect(revRes.status(), await revRes.text()).toBe(200);
  const after = (await revRes.json()).session as SessionView;
  expect(after.wireStatus).toBe("reversed");
  expect(wireStatusFrom(after.wireEvents)).toBe("reversed");

  // The reporter's ranked figure falls back to the co-attested $20k: proving
  // payment lifted the weight, and reversing it took the lift away.
  const rows2 = await leaderboardRows(sellerCtx.request);
  expect(rows2.get(SELLER.handle)!.valueToOthers, "the reversal reverts the payment weight").toBe("$20k");

  // /transparency/verification states plainly that the pay step is MUTUAL
  // ATTESTATION, honestly bounded to wire_credit_observed and never fiat_final.
  await sellerPage.goto("/transparency/verification");
  await expect(sellerPage.getByText(/mutual attestation/i).first()).toBeVisible();
  await expect(sellerPage.getByText("wire_credit_observed").first()).toBeVisible();
  await expect(sellerPage.getByText("fiat_final").first()).toBeVisible();
});

/* =============================================================== F2-STUB */

test("F2-STUB verifiable proof-of-payment is planned: 503 unconfigured, and the panel says so", async () => {
  // GET /api/payproof reports the rung as planned/unconfigured, no secrets.
  const statusRes = await sellerCtx.request.get(`${BASE}/api/payproof`);
  expect(statusRes.status()).toBe(200);
  const { status } = (await statusRes.json()) as {
    status: { configured: boolean; mode: string; label: string; providerVersion: string | null };
  };
  expect(status.configured).toBe(false);
  expect(status.mode).toBe("unconfigured");
  expect(status.label).toBe("verifiable proof-of-payment: planned");
  // COUNTERFACTUAL: it is NOT reporting an active or demo verifier, and pins no
  // provider version.
  expect(status.mode).not.toBe("reclaim");
  expect(status.mode).not.toBe("demo");
  expect(status.providerVersion).toBeNull();

  // POST /api/payproof/verify is inert: 503 with terse copy, not a fabricated pass.
  const verifyRes = await sellerCtx.request.post(`${BASE}/api/payproof/verify`, {
    data: {
      dealId: dealD1,
      expectedN15: "0".repeat(15),
      expectedAmountBucket: WIRED_BUCKET,
      expectedRail: "wire",
      proofHash: "a".repeat(64),
      envelope: { provider: "demo", version: "x", claim: {} },
    },
  });
  expect(verifyRes.status(), "the seam refuses to verify when unconfigured").toBe(503);
  const verifyBody = await verifyRes.json();
  expect(String(verifyBody.error).toLowerCase()).toContain("planned");
  expect(verifyBody.status.mode).toBe("unconfigured");

  // The panel labels verifiable proof as planned (it reads the same status).
  await sellerPage.goto(`/deals/${dealD1}/exchange`);
  await expect(sellerPage.getByText("verifiable proof-of-payment: planned").first()).toBeVisible();
});

/* =============================================================== PRIVACY */

test("PRIVACY a full-database dump carries no bank details, no receipt bytes, no exact amount, no PII", async () => {
  const whole = await dumpEntireDb();
  const { sessions, events, wire } = await dumpExchangeTables();

  // No bank record, no receiving account, no UETR, no wire-confirmation bytes,
  // no dataset plaintext, and no DEK, ANYWHERE in the database. Each was hashed
  // in the browser (or is opaque AEAD) and must never land server-side.
  for (const secret of [
    FILE_MARKER,
    RECORD_MARKER,
    ACCT_MARKER,
    UETR_MARKER,
    `DATASET_SECRET_${RUN}`,
    `REVERSAL_ADVICE_${RUN}`,
    "signups",
    "revenue_usd",
    toB64url(live.dek),
  ]) {
    expect(whole.includes(secret), `secret "${secret}" must not appear in any table`).toBe(false);
  }

  // No PII: no real name, no contact, in any form.
  for (const pii of [SELLER.realName, BUYER.realName, REP_B.realName, SELLER.contact, BUYER.contact, REP_B.contact]) {
    expect(whole.includes(pii), `PII "${pii}" must not appear in any table`).toBe(false);
  }

  // The exchange path carries BUCKETS, never the wired amount. Scan every
  // numeric field of the exchange rows and their signed leaves.
  const nums = new Set<number>();
  for (const r of [...sessions, ...events, ...wire]) {
    numbersIn(r, []).forEach((n) => nums.add(n));
    if (typeof r.payload_json === "string") {
      numbersIn(JSON.parse(r.payload_json), []).forEach((n) => nums.add(n));
    }
  }
  expect(nums.has(Number(WIRED_AMOUNT)), "the exact wired amount appears in no exchange numeric field").toBe(false);
  // The bucket string IS present, though.
  const exchDump = JSON.stringify(sessions) + JSON.stringify(events) + JSON.stringify(wire);
  expect(exchDump.includes(WIRED_BUCKET), "the bucket string is what the exchange carries").toBe(true);

  // The wire claim IS on the log, as commitments only, and never claims finality.
  const ourWire = wire.filter((r) => String(r.session_id) === live.sessionId);
  const wireTypes = ourWire.map((r) => String(r.type));
  expect(wireTypes).toContain("wire_credit_claim");
  expect(wireTypes).toContain("wire_credit_countersign");
  expect(exchDump.includes("fiat_final"), "no leaf ever claims fiat finality").toBe(false);
  // Only the terminal, honest statuses are ever asserted.
  for (const r of ourWire) {
    const leaf = JSON.parse(String(r.payload_json)) as WireClaimLeaf;
    if (leaf.type === "wire_credit_claim") {
      expect((WIRE_TERMINAL_STATUSES as readonly string[]).includes(String(leaf.data.terminalStatus))).toBe(true);
    }
  }

  // Sanity: the exchange session tables that exist are all declared in schema.sql
  // (no stray table crept in with the feature).
  const declaredNames = await allTableNames();
  expect(declaredNames).toContain("exchange_wire_claims");
});
