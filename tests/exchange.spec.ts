/**
 * tests/exchange.spec.ts
 *
 * The commit-encrypt-pay-reveal dataset exchange (Feature 3: lib/exchange.ts,
 * app/api/exchange/**), verified end to end. Two halves, both carrying
 * COUNTERFACTUALS the pre-change code (or a forged step) would have failed:
 *
 *   PURE   the browser crypto, in this process: signing keys are deterministic;
 *          a leaf's signature verifies and one flipped byte fails; the AEAD +
 *          Merkle manifest round-trips; a wrong key, a tampered chunk and a
 *          swapped root each fail with the right typed error; the hash-linked
 *          chain verifies and every tamper (reorder, relink, resign, illegal
 *          transition) is rejected.
 *
 *   LIVE   a real co-attested deal between two accounts runs the full protocol
 *          through the real API with each party's own session: seller commits,
 *          buyer verifies ciphertext, buyer signals payment, seller reveals the
 *          key, buyer decrypts and completes. Then the guards: a stranger's
 *          signature is refused, an out-of-order step conflicts, a non-party
 *          gets a 404, and a dump of the exchange tables shows the server holds
 *          NO dataset plaintext and NO key.
 *
 * Shared-DB discipline, like every suite here: it creates its own accounts via
 * operator-minted invite codes and asserts facts about its own session only.
 *
 * PRECONDITION: freshly reset + seeded DB and the built app on port 3947:
 *   SERVER_PEPPER=... npm run reset-db && npm run seed
 *   CI=1 SERVER_PEPPER=... npx playwright test tests/exchange.spec.ts
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
  deriveSigningKeys,
  generateDek,
  encryptDataset,
  ciphertextRootOf,
  decryptAndVerify,
  dekCommitHex,
  paymentCommitHex,
  eventHash,
  signLeaf,
  verifyLeafSignature,
  verifyChain,
  resolveTransition,
  newSessionId,
  sizeBucket,
  type ExchangeLeaf,
  type ExchangeRole,
  type StoredEvent,
} from "../lib/exchange";
import { toB64url, fromB64url } from "../lib/e2ee";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  encodeReceipt,
  verifyReceipt,
  canonicalJson,
  partyBaseFieldsFromPayload,
  receiptPayloadForDeal,
  mintReceiptForDeal,
  RECEIPT_PREFIX,
  type ReceiptPayload,
} from "../lib/receipts";
import {
  partySigningBase,
  signReceiptBase,
  verifyAttestation,
} from "../lib/receipt-attest";
import { verifyInclusionHex, verifySth, type Sth } from "../lib/merkle";
import type { DealDetail } from "../lib/deals";

const ROOT = path.resolve(__dirname, "..");
// Honor BLIND_TENDER_DB so a run can point BOTH the app server and this test's
// direct DB reads at an isolated file, away from a shared data/app.db that a
// second dev server would contend with (SQLITE_BUSY).
const DB_URL = process.env.BLIND_TENDER_DB ?? `file:${path.join(ROOT, "data", "app.db")}`;
const PORT = Number(process.env.PW_PORT ?? 3947);
const BASE = `http://localhost:${PORT}`;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PW = "exchange-verify-000";
const OPERATOR = { username: "marble-pennant", password: "demo-demo-demo" };

const SELLER = { realName: "Dana Holt", org: "Exchange Collective", contact: `ex-sell-${RUN}@example.org`, handle: "" };
const BUYER = { realName: "Wren Ames", contact: `ex-buy-${RUN}@example.org`, handle: "" };
const DEAL = { buyer: "Anthropic", total: "84000", myShare: "50000", partShare: "30000" };

/* A dataset with tokens we can later scan the server tables for. */
const DATASET =
  "row_id,region,signups,revenue_usd\n" +
  Array.from({ length: 40 }, (_, i) =>
    [`r${2000 + i}`, ["emea", "amer", "apac"][i % 3], 200 + i, (7000 + i * 91).toString()].join(","),
  ).join("\n") +
  "\nSECRET_MARKER_" + RUN + "\n";
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

/* --------------------------------------------------------------- crypto */

async function keysFor(handle: string) {
  return deriveSigningKeys(handle, PW);
}

function commitLeaf(args: {
  sessionId: string;
  dealId: string;
  seller: string;
  buyer: string;
  enc: Awaited<ReturnType<typeof encryptDataset>>;
  dekCommit: string;
  dekSalt: Uint8Array;
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
};

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

/* ============================================================ PURE crypto */

test("PURE signing keys are deterministic and a tampered leaf signature fails", async () => {
  const a = await deriveSigningKeys("dana-holt", "correct horse battery staple");
  const b = await deriveSigningKeys("dana-holt", "correct horse battery staple");
  const c = await deriveSigningKeys("dana-holt", "a different password entirely");
  expect(a.publicKey).toBe(b.publicKey); // same password+handle => same key, any device
  expect(a.publicKey).not.toBe(c.publicKey);
  expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const leaf: ExchangeLeaf = {
    v: EXCHANGE_VERSION,
    sessionId: newSessionId(),
    dealId: "deal_x",
    seq: 1,
    type: "commit",
    actorRole: "seller",
    actor: "dana-holt",
    prevHash: GENESIS_PREV_HASH,
    ts: 123,
    data: {
      plaintextRoot: "0".repeat(64),
      ciphertextRoot: "1".repeat(64),
      dekCommit: "2".repeat(64),
      dekSalt: "AA",
      chunkCount: 1,
      chunkSize: 256,
      sizeBucket: "<1 MB",
      buyer: "wren-ames",
    },
  };
  const sig = signLeaf(leaf, a.secretKey);
  expect(verifyLeafSignature(leaf, sig, a.publicKey)).toBe(true);
  // COUNTERFACTUAL: wrong key, mutated field, and mutated signature all fail.
  expect(verifyLeafSignature(leaf, sig, c.publicKey)).toBe(false);
  expect(verifyLeafSignature({ ...leaf, ts: 124 }, sig, a.publicKey)).toBe(false);
  expect(verifyLeafSignature(leaf, flipB64(sig), a.publicKey)).toBe(false);
});

test("PURE encrypt/manifest round-trips; wrong key, tampered chunk and swapped root each fail typed", async () => {
  const sessionId = newSessionId();
  const dealId = "deal_pure";
  const data = new TextEncoder().encode(DATASET);
  const dek = generateDek();
  const salt = new Uint8Array(16).fill(7);
  const enc = await encryptDataset(sessionId, data, dek, CHUNK);
  expect(enc.chunkCount).toBeGreaterThan(1); // the dataset really did chunk
  expect(enc.sizeBucket).toBe(sizeBucket(data.length));

  // The buyer recomputes the ciphertext root from the blob alone.
  expect(ciphertextRootOf(enc.ciphertext, enc.chunkSize, enc.chunkCount)).toBe(enc.ciphertextRoot);
  // COUNTERFACTUAL: a flipped ciphertext byte changes the recomputed root.
  const tamperedBlob = new Uint8Array(enc.ciphertext);
  tamperedBlob[20] ^= 0x01;
  expect(ciphertextRootOf(tamperedBlob, enc.chunkSize, enc.chunkCount)).not.toBe(enc.ciphertextRoot);

  const dekCommit = dekCommitHex(dealId, salt, dek);
  const good = await decryptAndVerify({
    sessionId, dealId, blob: enc.ciphertext, dek, dekSalt: salt, dekCommit,
    chunkSize: enc.chunkSize, chunkCount: enc.chunkCount, plaintextRoot: enc.plaintextRoot,
  });
  expect(good.ok).toBe(true);
  if (good.ok) expect(new TextDecoder().decode(good.plaintext)).toBe(DATASET);

  // Wrong key: fails the commitment check before it can decrypt.
  const wrong = await decryptAndVerify({
    sessionId, dealId, blob: enc.ciphertext, dek: generateDek(), dekSalt: salt, dekCommit,
    chunkSize: enc.chunkSize, chunkCount: enc.chunkCount, plaintextRoot: enc.plaintextRoot,
  });
  expect(wrong.ok).toBe(false);
  if (!wrong.ok) expect(wrong.error).toBe("bad_dek");

  // Right key, tampered ciphertext: AEAD authentication fails.
  const auth = await decryptAndVerify({
    sessionId, dealId, blob: tamperedBlob, dek, dekSalt: salt, dekCommit,
    chunkSize: enc.chunkSize, chunkCount: enc.chunkCount, plaintextRoot: enc.plaintextRoot,
  });
  expect(auth.ok).toBe(false);
  if (!auth.ok) expect(["auth", "bad_dek"]).toContain(auth.error);

  // Right key, decrypts, but the committed plaintext root was swapped.
  const rootMismatch = await decryptAndVerify({
    sessionId, dealId, blob: enc.ciphertext, dek, dekSalt: salt, dekCommit,
    chunkSize: enc.chunkSize, chunkCount: enc.chunkCount, plaintextRoot: "9".repeat(64),
  });
  expect(rootMismatch.ok).toBe(false);
  if (!rootMismatch.ok) expect(rootMismatch.error).toBe("root_mismatch");
});

test("PURE the hash-linked chain verifies; reorder, relink, resign and illegal transitions all fail", async () => {
  const seller = await deriveSigningKeys("seller-h", PW);
  const buyer = await deriveSigningKeys("buyer-h", PW);
  const sessionId = newSessionId();
  const dealId = "deal_chain";

  const l1 = commitLeaf({
    sessionId, dealId, seller: "seller-h", buyer: "buyer-h",
    enc: await encryptDataset(sessionId, new TextEncoder().encode("x"), generateDek(), CHUNK),
    dekCommit: "3".repeat(64), dekSalt: new Uint8Array(16),
  });
  const h1 = eventHash(l1);
  const l2 = nextLeaf({ id: sessionId, dealId, headSeq: 1, headHash: h1 }, "buyer", "buyer-h", "ciphertext_ack", {
    ciphertextRoot: String(l1.data.ciphertextRoot),
  });
  const h2 = eventHash(l2);

  const events: StoredEvent[] = [
    stored(l1, seller, h1),
    stored(l2, buyer, h2),
  ];
  expect(verifyChain(sessionId, dealId, events).ok).toBe(true);

  // COUNTERFACTUAL: reordering the two events breaks seq and prevHash.
  expect(verifyChain(sessionId, dealId, [events[1], events[0]]).ok).toBe(false);
  // COUNTERFACTUAL: relinking event 2 to a different prevHash fails.
  const relinked = { ...events[1], prevHash: "a".repeat(64) };
  expect(verifyChain(sessionId, dealId, [events[0], relinked]).ok).toBe(false);
  // COUNTERFACTUAL: re-signing event 2's payload with the wrong key fails.
  const resigned = { ...events[1], signerPubkey: seller.publicKey };
  expect(verifyChain(sessionId, dealId, [events[0], resigned]).ok).toBe(false);
  // COUNTERFACTUAL: a stored eventHash that does not match the leaf fails.
  const badHash = { ...events[1], eventHash: "b".repeat(64) };
  expect(verifyChain(sessionId, dealId, [events[0], badHash]).ok).toBe(false);

  // The transition table itself: legal and illegal moves.
  expect(resolveTransition("committed", "ciphertext_ack", "buyer").ok).toBe(true);
  expect(resolveTransition("committed", "ciphertext_ack", "seller").ok).toBe(false); // wrong role
  expect(resolveTransition("committed", "dek_revealed", "seller").ok).toBe(false); // out of order
  expect(resolveTransition("completed", "abort", "buyer").ok).toBe(false); // terminal
  expect(resolveTransition("payment_signaled", "abort", "buyer").ok).toBe(true); // abort always ok
});

function stored(leaf: ExchangeLeaf, keys: { publicKey: string; secretKey: Uint8Array }, hash: string): StoredEvent {
  return {
    seq: leaf.seq,
    type: leaf.type,
    actorRole: leaf.actorRole,
    actor: leaf.actor,
    prevHash: leaf.prevHash,
    ts: leaf.ts,
    data: leaf.data,
    eventHash: hash,
    signerPubkey: keys.publicKey,
    signature: signLeaf(leaf, keys.secretKey),
  };
}

function flipB64(s: string): string {
  // Flip the FIRST char, not the last: the last base64url char of an 86-char
  // (64-byte) signature carries padding bits that decode to the same bytes, so
  // flipping it would not change the signature. The first char is load-bearing.
  return (s[0] === "A" ? "B" : "A") + s.slice(1);
}

/* ================================================= OTS external anchoring */

/**
 * The OpenTimestamps proof (scripts/ots-anchor.ts) is the log root's REAL
 * external anchor: it commits the signed-tree-head bytes into Bitcoin's
 * timestamp through calendar servers the operator does not run, so a forged or
 * backdated head past an anchored point is externally detectable. Live calendar
 * submission is network-bound and slow in CI (the seed permits the fallback), so
 * this asserts the committed pending proof exactly as the script writes it: the
 * proof binds the exact bytes of the head file through the documented OTS wire
 * format, and a tampered head would not match. Fully offline and deterministic.
 */
test("OTS the committed proof anchors the signed head's exact bytes, wire-format valid", () => {
  const otsDir = path.join(ROOT, "docs", "transparency-log", "ots");
  expect(existsSync(otsDir), "docs/transparency-log/ots path exists").toBe(true);

  // The head the anchor stamped, and its digest (what the .ots must commit to).
  const sthPath = path.join(ROOT, "docs", "transparency-log", "sth-3.json");
  expect(existsSync(sthPath)).toBe(true);
  const sthBytes = readFileSync(sthPath);
  const digest = createHash("sha256").update(sthBytes).digest(); // 32 bytes

  // The run record the script appends: pending proof stored, digest matches.
  const meta = JSON.parse(readFileSync(path.join(otsDir, "sth-3.ots.json"), "utf8")) as {
    sha256: string;
    pending: boolean;
    calendars: { name: string }[];
  };
  expect(meta.sha256).toBe(digest.toString("hex"));
  expect(meta.pending, "freshly stamped proofs are PENDING Bitcoin confirmation").toBe(true);
  expect(meta.calendars.length).toBeGreaterThan(0);
  const stamps = readFileSync(path.join(otsDir, "stamps.ndjson"), "utf8").trim().split("\n");
  expect(stamps.some((l) => JSON.parse(l).sha256 === digest.toString("hex"))).toBe(true);

  // The OpenTimestamps DetachedTimestampFile header, byte-for-byte the assembly
  // scripts/ots-anchor.ts (buildOts) writes: magic || v(1) || OpSHA256(0x08) ||
  // the 32-byte file digest, then the calendar timestamp. Rebuild the 65-byte
  // prefix here and require every committed .ots to carry it.
  const magic = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from("OpenTimestamps", "ascii"),
    Buffer.from([0x00, 0x00]),
    Buffer.from("Proof", "ascii"),
    Buffer.from([0x00]),
    Buffer.from([0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]),
  ]);
  const prefix = Buffer.concat([magic, Buffer.from([0x01]), Buffer.from([0x08]), digest]);

  let proofsChecked = 0;
  for (const cal of meta.calendars) {
    const otsPath = path.join(otsDir, `sth-3.${cal.name}.ots`);
    expect(existsSync(otsPath), `pending proof ${cal.name} stored`).toBe(true);
    const ots = readFileSync(otsPath);
    expect(
      ots.subarray(0, prefix.length).equals(prefix),
      `${cal.name}.ots commits the head digest in OTS wire format`,
    ).toBe(true);
    expect(ots.length).toBeGreaterThan(prefix.length); // a real calendar timestamp follows
    proofsChecked++;
  }
  expect(proofsChecked).toBeGreaterThanOrEqual(2); // multiple independent calendars

  // COUNTERFACTUAL: a one-byte change to the head yields a different digest, so
  // the committed proofs anchor THAT head's bytes and nothing else. A tampered
  // head does not carry the digest the .ots commits to.
  const tampered = Buffer.from(sthBytes);
  tampered[10] ^= 0x01;
  const tamperedDigest = createHash("sha256").update(tampered).digest();
  expect(tamperedDigest.equals(digest)).toBe(false);
  const alice = readFileSync(path.join(otsDir, "sth-3.alice.ots"));
  expect(alice.includes(digest), "the real head digest is inside the proof").toBe(true);
  expect(alice.includes(tamperedDigest), "a tampered head's digest is not").toBe(false);
});

/* ============================================================= LIVE flow */

test.describe.configure({ mode: "serial" });

let sellerCtx: BrowserContext;
let buyerCtx: BrowserContext;
let sellerPage: Page;
let buyerPage: Page;
let dealId = "";
let sigToken = ""; // the both-party-signed receipt, set by SIG-1, read by SIG-2 / PRIVACY
let sellerKeys: Awaited<ReturnType<typeof keysFor>>;
let buyerKeys: Awaited<ReturnType<typeof keysFor>>;
let live: {
  sessionId: string;
  dek: Uint8Array;
  dekSalt: Uint8Array;
  enc: Awaited<ReturnType<typeof encryptDataset>>;
};

test.beforeAll(async ({ browser }) => {
  sellerCtx = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "198.51.100.201" } });
  buyerCtx = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "198.51.100.202" } });
  sellerPage = await sellerCtx.newPage();
  buyerPage = await buyerCtx.newPage();
});

test.afterAll(async () => {
  await sellerCtx?.close();
  await buyerCtx?.close();
});

test("00 fixture: two accounts and a co-attested deal", async ({ request }) => {
  await clearRateLimits();
  const [cSell, cBuy] = await mintOperatorCodes(request, 2);
  SELLER.handle = await signUp(sellerPage, { realName: SELLER.realName, org: SELLER.org, contact: SELLER.contact, inviteCode: cSell });
  BUYER.handle = await signUp(buyerPage, { realName: BUYER.realName, contact: BUYER.contact, inviteCode: cBuy });

  dealId = await recordDeal(sellerPage, {
    buyer: DEAL.buyer,
    total: DEAL.total,
    myShare: DEAL.myShare,
    participant: [BUYER.handle, DEAL.partShare],
  });
  await confirmMyShare(buyerPage);

  sellerKeys = await keysFor(SELLER.handle);
  buyerKeys = await keysFor(BUYER.handle);
  expect(dealId.length).toBeGreaterThan(0);
});

test("EX-1 seller commits: encrypted, signed, and the server stores only the commitment", async () => {
  const sessionId = newSessionId();
  const dek = generateDek();
  const dekSalt = new Uint8Array(16);
  crypto.getRandomValues(dekSalt);
  const enc = await encryptDataset(sessionId, new TextEncoder().encode(DATASET), dek, CHUNK);
  const dekCommit = dekCommitHex(dealId, dekSalt, dek);
  const leaf = commitLeaf({ sessionId, dealId, seller: SELLER.handle, buyer: BUYER.handle, enc, dekCommit, dekSalt });

  const res = await postSigned(sellerCtx.request, `${BASE}/api/exchange`, leaf, sellerKeys);
  expect(res.status(), await res.text()).toBe(201);
  const session = (await res.json()).session as SessionView;
  expect(session.state).toBe("committed");
  expect(session.ciphertextRoot).toBe(enc.ciphertextRoot);
  expect(session.dekCommit).toBe(dekCommit);

  // Deliver the opaque ciphertext through the demo carrier.
  const up = await sellerCtx.request.post(`${BASE}/api/exchange/${sessionId}/blob`, {
    data: { ciphertext: toB64url(enc.ciphertext) },
  });
  expect(up.status()).toBe(200);

  live = { sessionId, dek, dekSalt, enc };
});

test("EX-2 buyer verifies the ciphertext against the commitment and signs the ack", async () => {
  const got = await buyerCtx.request.get(`${BASE}/api/exchange/${live.sessionId}`);
  expect(got.status()).toBe(200);
  const session = (await got.json()).session as SessionView;
  expect(session.state).toBe("committed");

  const blobRes = await buyerCtx.request.get(`${BASE}/api/exchange/${live.sessionId}/blob`);
  const blobB64 = (await blobRes.json()).ciphertext as string;
  const blob = fromB64url(blobB64)!;
  const root = ciphertextRootOf(blob, session.chunkSize, session.chunkCount);
  expect(root).toBe(session.ciphertextRoot); // buyer recomputed it, did not trust the label

  const leaf = nextLeaf(session, "buyer", BUYER.handle, "ciphertext_ack", { ciphertextRoot: root });
  const res = await postSigned(buyerCtx.request, `${BASE}/api/exchange/${live.sessionId}/events`, leaf, buyerKeys);
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).session.state).toBe("ciphertext_ack");
});

test("EX-3 buyer signals payment as a commitment with no amount", async () => {
  const session = await fetchSession(buyerCtx.request, live.sessionId);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const commit = paymentCommitHex(salt, `wire-${RUN}`);
  const leaf = nextLeaf(session, "buyer", BUYER.handle, "payment_signaled", { paymentCommit: commit, method: "wire" });
  const res = await postSigned(buyerCtx.request, `${BASE}/api/exchange/${live.sessionId}/events`, leaf, buyerKeys);
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).session.state).toBe("payment_signaled");
});

test("EX-4 seller reveals the key; the server records only that the commitment was opened", async () => {
  const session = await fetchSession(sellerCtx.request, live.sessionId);
  const leaf = nextLeaf(session, "seller", SELLER.handle, "dek_revealed", { dekCommit: session.dekCommit });
  const res = await postSigned(sellerCtx.request, `${BASE}/api/exchange/${live.sessionId}/events`, leaf, sellerKeys);
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).session.state).toBe("dek_revealed");
});

test("EX-5 buyer decrypts, verifies against the plaintext root, and completes", async () => {
  const session = await fetchSession(buyerCtx.request, live.sessionId);
  const blobRes = await buyerCtx.request.get(`${BASE}/api/exchange/${live.sessionId}/blob`);
  const blob = fromB64url((await blobRes.json()).ciphertext as string)!;
  const dekSalt = fromB64url(String(session.events[0].data.dekSalt))!;

  // The buyer receives the key out of band (here: the seller's own bytes) and
  // verifies it end to end before completing.
  const result = await decryptAndVerify({
    sessionId: session.id,
    dealId: session.dealId,
    blob,
    dek: live.dek,
    dekSalt,
    dekCommit: session.dekCommit,
    chunkSize: session.chunkSize,
    chunkCount: session.chunkCount,
    plaintextRoot: session.plaintextRoot,
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(new TextDecoder().decode(result.plaintext)).toBe(DATASET);

  const leaf = nextLeaf(session, "buyer", BUYER.handle, "completed", { plaintextRoot: session.plaintextRoot });
  const res = await postSigned(buyerCtx.request, `${BASE}/api/exchange/${live.sessionId}/events`, leaf, buyerKeys);
  expect(res.status(), await res.text()).toBe(200);
  const final = (await res.json()).session as SessionView;
  expect(final.state).toBe("completed");
  expect(final.events.length).toBe(5);
  // The whole chain reverifies in this process against the served leaves.
  expect(verifyChain(final.id, final.dealId, final.events).ok).toBe(true);
});

test("EX-5b the exchange PAGE renders the completed session: ladder, terminal note, signed chain", async () => {
  // The completed session is still the latest on this deal, so the deal-scoped
  // page shows it. (EX-6 opens a second session after this.)
  await sellerPage.goto(`/deals/${dealId}/exchange`);
  await expect(sellerPage.getByRole("heading", { name: "Commit, encrypt, pay, reveal." })).toBeVisible();
  await expect(sellerPage.getByText(/does not make the trade atomic/i)).toBeVisible();
  await expect(sellerPage.getByText("Exchange complete")).toBeVisible();
  await expect(sellerPage.getByText(/chain verified/)).toBeVisible();
  await expect(sellerPage.getByText("Signed event chain")).toBeVisible();
  // The deal page offers the exchange to a confirmed participant.
  await sellerPage.goto(`/deals/${dealId}`);
  await expect(sellerPage.getByRole("link", { name: "Open the exchange" })).toBeVisible();
});

test("EX-6 GUARDS: a stranger key, an out-of-order step, and a non-party read are all refused", async () => {
  // A fresh session to attack (the completed one is terminal).
  const sessionId = newSessionId();
  const dek = generateDek();
  const dekSalt = new Uint8Array(16);
  const enc = await encryptDataset(sessionId, new TextEncoder().encode("guardrail dataset"), dek, CHUNK);
  const leaf = commitLeaf({ sessionId, dealId, seller: SELLER.handle, buyer: BUYER.handle, enc, dekCommit: dekCommitHex(dealId, dekSalt, dek), dekSalt });
  expect((await postSigned(sellerCtx.request, `${BASE}/api/exchange`, leaf, sellerKeys)).status()).toBe(201);
  await sellerCtx.request.post(`${BASE}/api/exchange/${sessionId}/blob`, { data: { ciphertext: toB64url(enc.ciphertext) } });
  const session = await fetchSession(buyerCtx.request, sessionId);

  // A stranger's key on a valid-looking buyer ack: signature does not match the
  // registered buyer identity, and it is not the pinned buyer key either.
  const stranger = await deriveSigningKeys("mallory", "totally different secret");
  const ackLeaf = nextLeaf(session, "buyer", BUYER.handle, "ciphertext_ack", { ciphertextRoot: session.ciphertextRoot });
  const forged = await buyerCtx.request.post(`${BASE}/api/exchange/${sessionId}/events`, {
    data: { leaf: ackLeaf, eventHash: eventHash(ackLeaf), signature: signLeaf(ackLeaf, stranger.secretKey), signerPubkey: stranger.publicKey },
  });
  expect(forged.status(), "forged signature must be rejected").toBe(400);

  // A well-signed but out-of-order step (skipping ack, jumping to complete).
  const jump = nextLeaf(session, "buyer", BUYER.handle, "completed", { plaintextRoot: session.plaintextRoot });
  const outOfOrder = await postSigned(buyerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, jump, buyerKeys);
  expect([400, 409]).toContain(outOfOrder.status());

  // The seller signing a step that is the buyer's to make.
  const wrongRole = nextLeaf(session, "seller", SELLER.handle, "ciphertext_ack", { ciphertextRoot: session.ciphertextRoot });
  const roleRes = await postSigned(sellerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, wrongRole, sellerKeys);
  expect([400, 409]).toContain(roleRes.status());

  // A logged-in third party (the operator) cannot even read the session.
  const opCtx = await sellerCtx.browser()!.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "198.51.100.9" } });
  await opCtx.request.post(`${BASE}/api/auth/login`, { data: { username: OPERATOR.username, password: OPERATOR.password } });
  const peek = await opCtx.request.get(`${BASE}/api/exchange/${sessionId}`);
  expect(peek.status(), "a non-participant gets 404, indistinguishable from absent").toBe(404);
  await opCtx.close();
});

test("EX-7 PRIVACY: the server tables hold no dataset plaintext and no key", async () => {
  const c = db();
  const sessions = await c.execute("SELECT * FROM exchange_sessions");
  const events = await c.execute("SELECT * FROM exchange_events");
  c.close();

  const marker = `SECRET_MARKER_${RUN}`;
  const dekB64 = toB64url(live.dek);
  const plaintextTokens = ["signups", "revenue_usd", marker];

  const dumpAll = JSON.stringify(sessions.rows) + JSON.stringify(events.rows);
  // The demo carrier holds AEAD ciphertext; the plaintext markers and the key
  // must appear NOWHERE in any exchange row, including that opaque blob.
  for (const tok of plaintextTokens) {
    expect(dumpAll.includes(tok), `plaintext token "${tok}" must not appear in the exchange tables`).toBe(false);
  }
  expect(dumpAll.includes(dekB64), "the DEK must never reach the server").toBe(false);

  // What IS there: our live session, its commitments, its state and signatures.
  const ours = sessions.rows.find((r) => String(r.id) === live.sessionId);
  expect(ours, "our session row exists").toBeTruthy();
  expect(String(ours!.state)).toBe("completed");
  expect(String(ours!.dek_commit)).toMatch(/^[0-9a-f]{64}$/);
  // demo_ciphertext is present (the demo path) but is opaque bytes.
  expect(ours!.demo_ciphertext).toBeTruthy();
});

/* ================================================= SIG: party-signed receipts */

function decodeReceipt(token: string): ReceiptPayload {
  return JSON.parse(Buffer.from(token.trim().split(".")[1], "base64url").toString("utf8"));
}

async function receiptTokenFromDealPage(p: Page): Promise<string> {
  await p.goto(`/deals/${dealId}`);
  await expect(p.getByText("Portable receipt · engagement certificate")).toBeVisible();
  await p.getByRole("button", { name: "Show token" }).click();
  const token = (
    await p.getByText(new RegExp(`^${RECEIPT_PREFIX}\\.`)).first().innerText()
  ).trim();
  expect(token).toMatch(new RegExp(`^${RECEIPT_PREFIX}\\.[A-Za-z0-9_-]+\\.[0-9a-f]+$`));
  return token;
}

test("SIG-1 both parties sign the co-attested receipt; verify shows both sigs valid AND log inclusion", async ({
  request,
}) => {
  // The fixture's co-attested deal mints a LOG-BOUND receipt. Its roster is the
  // two confirmed parties, each carrying the signing key their signup registered
  // (deriveSigningKeys, the very key the exchange steps are signed with).
  const token0 = await receiptTokenFromDealPage(sellerPage);
  const p0 = decodeReceipt(token0);
  expect(p0.tier).toBe("co_attested");
  expect(p0.dealId).toBe(dealId);
  const fields = partyBaseFieldsFromPayload(p0);
  expect(fields, "a log-bound receipt yields a party-signing base").toBeTruthy();
  expect(fields!.signers.map((s) => s.handle).sort()).toEqual(
    [SELLER.handle, BUYER.handle].sort(),
  );
  const byHandle = new Map(fields!.signers.map((s) => [s.handle, s.pubkey]));
  expect(byHandle.get(SELLER.handle)).toBe(sellerKeys.publicKey);
  expect(byHandle.get(BUYER.handle)).toBe(buyerKeys.publicKey);

  // Each party signs the canonical receipt base with their OWN key and posts it.
  // The base fixes tier, buyer, bucket, attestedAt, translog seq and the roster,
  // so a signature also pins WHO ELSE is on the receipt.
  const base = partySigningBase(fields!);
  const sellerSig = signReceiptBase(base, sellerKeys.secretKey);
  const buyerSig = signReceiptBase(base, buyerKeys.secretKey);
  const rs = await sellerCtx.request.post(`${BASE}/api/deals/${dealId}/receipt-sign`, {
    data: { pubkey: sellerKeys.publicKey, sig: sellerSig },
  });
  expect(rs.status(), await rs.text()).toBe(200);
  const rb = await buyerCtx.request.post(`${BASE}/api/deals/${dealId}/receipt-sign`, {
    data: { pubkey: buyerKeys.publicKey, sig: buyerSig },
  });
  expect(rb.status(), await rb.text()).toBe(200);

  // The re-rendered receipt now folds BOTH party signatures into the token.
  sigToken = await receiptTokenFromDealPage(sellerPage);
  const p1 = decodeReceipt(sigToken);
  expect(p1.attest, "attestation block present").toBeTruthy();
  expect(p1.attest!.sigs.map((s) => s.handle).sort()).toEqual(
    [SELLER.handle, BUYER.handle].sort(),
  );

  // (a) The platform MAC verifies: DataBoard signed it, nothing was altered.
  const vr = await request.post(`${BASE}/api/receipts/verify`, { data: { token: sigToken } });
  expect(vr.status()).toBe(200);
  expect((await vr.json()).valid).toBe(true);

  // (b) BOTH party signatures verify against the roster's registered keys, in
  // this process, exactly as the /receipts/verify page does it in the browser.
  const fields1 = partyBaseFieldsFromPayload(p1)!;
  const ver = verifyAttestation(fields1, p1.attest!.sigs);
  expect(ver.valid.sort()).toEqual([SELLER.handle, BUYER.handle].sort());
  expect(ver.invalid).toEqual([]);
  expect(ver.allSigned, "every named party signed with their own key").toBe(true);

  // The public directory serves each party's registered key and it equals the
  // pubkey the receipt's roster carries: the verifier's directory check.
  for (const s of fields1.signers) {
    const dir = await request.get(`${BASE}/api/signing/pubkey?handle=${s.handle}`);
    expect((await dir.json()).pubkey).toBe(s.pubkey);
  }

  // (c) LOG INCLUSION valid: the receipt's leaf proves into a signed head here.
  expect(p1.log, "receipt bound to the transparency log").toBeTruthy();
  const pr = await request.get(
    `${BASE}/api/translog/proof/inclusion?leaf=${encodeURIComponent(p1.log!.leafHash)}`,
  );
  expect(pr.ok()).toBe(true);
  const proof = (await pr.json()) as {
    leafHash: string;
    leafIndex: number;
    treeSize: number;
    auditPath: string[];
    sth: Sth;
  };
  const { publicKey } = (await (await request.get(`${BASE}/api/translog/pubkey`)).json()) as {
    publicKey: string;
  };
  expect(
    verifyInclusionHex({
      leafHash: proof.leafHash,
      leafIndex: proof.leafIndex,
      treeSize: proof.treeSize,
      auditPath: proof.auditPath,
      root: proof.sth.rootHash,
    }),
    "inclusion proof recomputes the signed root",
  ).toBe(true);
  expect(verifySth(proof.sth, publicKey), "the head at that size is signed").toBe(true);

  // COUNTERFACTUAL: flip one byte of the seller's party signature. That handle
  // now shows invalid, the receipt is no longer fully signed, and the OTHER
  // party's signature is unaffected. The party layer is not vacuously true.
  const tamperedSigs = p1.attest!.sigs.map((s) =>
    s.handle === SELLER.handle ? { ...s, sig: flipB64(s.sig) } : s,
  );
  const bad = verifyAttestation(fields1, tamperedSigs);
  expect(bad.valid).toEqual([BUYER.handle]);
  expect(bad.invalid).toEqual([SELLER.handle]);
  expect(bad.allSigned).toBe(false);
});

test("SIG-2 the platform alone cannot forge a co-attested receipt: a wrong-key party sig is caught", async ({
  request,
}) => {
  expect(sigToken.length, "SIG-1 produced the signed receipt").toBeGreaterThan(0);
  const genuine = decodeReceipt(sigToken);
  const fields = partyBaseFieldsFromPayload(genuine)!;
  const base = partySigningBase(fields);

  // The test process and the server share this instance's pepper, so
  // encodeReceipt reproduces the genuine token's MAC byte for byte: that is
  // precisely the power the OPERATOR has (it holds the MAC key). Prove parity.
  expect(encodeReceipt(genuine), "encodeReceipt reproduces the MAC (operator power)").toBe(
    sigToken,
  );

  // A key that is NOT any party's registered signing key.
  const wrong = await deriveSigningKeys("mallory-forger", "an unrelated secret");
  const sellerReg = fields.signers.find((s) => s.handle === SELLER.handle)!.pubkey;
  expect(wrong.publicKey).not.toBe(sellerReg);
  const forgedSig = signReceiptBase(base, wrong.secretKey); // valid Ed25519, wrong key
  const buyerReal = genuine.attest!.sigs.find((s) => s.handle === BUYER.handle)!;
  const forgedPayload: ReceiptPayload = {
    ...genuine,
    attest: {
      signers: genuine.attest!.signers,
      sigs: [{ handle: SELLER.handle, sig: forgedSig }, buyerReal],
    },
  };

  // (a) OPERATOR FORGERY: swap in the wrong-key sig and RE-MAC the whole token
  // (operator power). The platform MAC now verifies as valid...
  const forgedToken = encodeReceipt(forgedPayload);
  const vr = await request.post(`${BASE}/api/receipts/verify`, { data: { token: forgedToken } });
  expect(vr.status()).toBe(200);
  expect((await vr.json()).valid, "the operator CAN forge its own MAC (honest limit)").toBe(true);
  // ...but the PARTY layer catches it: the forged seller sig does not verify
  // against the seller's REGISTERED directory key, so the receipt is not fully
  // party-attested. This is the thing the operator cannot fake without the key.
  const ver = verifyAttestation(fields, forgedPayload.attest!.sigs);
  expect(ver.valid).toEqual([BUYER.handle]);
  expect(ver.invalid).toEqual([SELLER.handle]);
  expect(ver.allSigned).toBe(false);
  const dir = await request.get(`${BASE}/api/signing/pubkey?handle=${SELLER.handle}`);
  expect((await dir.json()).pubkey, "the directory holds the real key, not the forger's").toBe(
    sellerReg,
  );

  // (b) SPLICE WITHOUT RE-MAC: drop the wrong-key sig into the genuine token but
  // keep its original MAC. The MAC binds the attest block, so /api/receipts/verify
  // itself REJECTS it (a receipt whose party sigs were swapped in fails to verify).
  const parts = sigToken.split(".");
  const splicedBody = Buffer.from(canonicalJson(forgedPayload), "utf8").toString("base64url");
  const spliced = `${parts[0]}.${splicedBody}.${parts[2]}`;
  const vr2 = await request.post(`${BASE}/api/receipts/verify`, { data: { token: spliced } });
  expect(vr2.status()).toBe(200);
  const body2 = (await vr2.json()) as { valid: boolean; error?: string };
  expect(body2.valid, "splicing a sig into a genuine token breaks the MAC").toBe(false);
  expect(body2.error).toBe("bad_signature");
});

test("SIG-solo a solo/unattested deal offers no dual-signed receipt", async () => {
  // Pure: a claimed (solo/unconfirmed) deal mints no receipt at all.
  const split = [
    { userId: "u1", username: "aa", role: "reporter", status: "confirmed", confirmedAt: 1, shareUsd: 40_000 },
  ];
  const claimed = {
    id: "unit-solo",
    tier: "claimed",
    buyerToken: "v2:dead",
    buyerIsOther: false,
    totalUsd: 40_000,
    split,
  } as unknown as DealDetail;
  expect(receiptPayloadForDeal(claimed)).toBeNull();
  expect(mintReceiptForDeal(claimed)).toBeNull();

  // Live: record a solo deal (no participants). Its page shows it is solo and
  // offers NO receipt token and NO party-signature panel to sign.
  await sellerPage.goto("/deals/new");
  await expect(sellerPage.getByText("Say what closed, and who was in it.")).toBeVisible();
  await sellerPage.getByLabel("Buying lab").selectOption(DEAL.buyer);
  await sellerPage.getByLabel("Total value, USD").fill("41000");
  await sellerPage.getByLabel("Your share, USD").fill("41000");
  await sellerPage.getByRole("button", { name: "Record the deal" }).click();
  await sellerPage.waitForURL(/\/deals\/(?!new$)[^/]+$/);

  await expect(sellerPage.getByText("solo deal").first()).toBeVisible();
  await expect(
    sellerPage.getByText("Portable receipt · engagement certificate"),
  ).toHaveCount(0);
  await expect(sellerPage.getByRole("button", { name: "Show token" })).toHaveCount(0);
  await expect(sellerPage.getByText("Party signatures")).toHaveCount(0);
});

/* ================================================= EXCH-cheat: seller stops */

test("EXCH-cheat the seller stops after the buyer paid; the signed chain proves non-reveal; a forged next step is refused", async () => {
  // A fresh session on the same deal. Seller commits and delivers the ciphertext.
  const sessionId = newSessionId();
  const dek = generateDek();
  const dekSalt = new Uint8Array(16);
  crypto.getRandomValues(dekSalt);
  const enc = await encryptDataset(sessionId, new TextEncoder().encode(DATASET), dek, CHUNK);
  expect(
    enc.chunkCount,
    "the dataset chunked, so a stop-after-receiving caps exposure to one chunk",
  ).toBeGreaterThan(1);
  const dekCommit = dekCommitHex(dealId, dekSalt, dek);
  const commit = commitLeaf({ sessionId, dealId, seller: SELLER.handle, buyer: BUYER.handle, enc, dekCommit, dekSalt });
  expect((await postSigned(sellerCtx.request, `${BASE}/api/exchange`, commit, sellerKeys)).status()).toBe(201);
  await sellerCtx.request.post(`${BASE}/api/exchange/${sessionId}/blob`, {
    data: { ciphertext: toB64url(enc.ciphertext) },
  });

  // Buyer verifies the ciphertext against the commitment and signs the ack.
  let session = await fetchSession(buyerCtx.request, sessionId);
  const blob = fromB64url(
    (await (await buyerCtx.request.get(`${BASE}/api/exchange/${sessionId}/blob`)).json()).ciphertext,
  )!;
  expect(ciphertextRootOf(blob, session.chunkSize, session.chunkCount)).toBe(session.ciphertextRoot);
  const ack = nextLeaf(session, "buyer", BUYER.handle, "ciphertext_ack", {
    ciphertextRoot: session.ciphertextRoot,
  });
  expect((await postSigned(buyerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, ack, buyerKeys)).status()).toBe(200);

  // Buyer signals payment: a signed, on-record obligation with no amount.
  session = await fetchSession(buyerCtx.request, sessionId);
  const paySalt = new Uint8Array(16);
  crypto.getRandomValues(paySalt);
  const pay = nextLeaf(session, "buyer", BUYER.handle, "payment_signaled", {
    paymentCommit: paymentCommitHex(paySalt, `wire-cheat-${RUN}`),
    method: "wire",
  });
  expect((await postSigned(buyerCtx.request, `${BASE}/api/exchange/${sessionId}/events`, pay, buyerKeys)).status()).toBe(200);

  // THE SELLER STOPS. No dek_revealed. What the shared, signed chain now proves:
  const stuck = await fetchSession(buyerCtx.request, sessionId);
  expect(stuck.state).toBe("payment_signaled");
  expect(stuck.events.length).toBe(3);
  // the chain is internally valid and tamper-evident;
  expect(verifyChain(stuck.id, stuck.dealId, stuck.events).ok).toBe(true);
  // it carries the seller's OWN signed commit and the buyer's OWN signed ack and
  // payment, each against that party's pinned identity key (non-repudiable);
  const commitEv = stuck.events.find((e) => e.type === "commit")!;
  const ackEv = stuck.events.find((e) => e.type === "ciphertext_ack")!;
  const payEv = stuck.events.find((e) => e.type === "payment_signaled")!;
  expect(commitEv.signerPubkey).toBe(sellerKeys.publicKey);
  expect(ackEv.signerPubkey).toBe(buyerKeys.publicKey); // buyer, provably, received the ciphertext
  expect(payEv.signerPubkey).toBe(buyerKeys.publicKey); // buyer, provably, signaled payment
  expect(ackEv.signerPubkey).toBe(stuck.buyerSigningPubkey); // pinned to the buyer's identity key
  // and there is NO dek_revealed: the seller's non-performance is on the record.
  expect(stuck.events.some((e) => e.type === "dek_revealed")).toBe(false);
  expect(stuck.events.some((e) => e.type === "completed")).toBe(false);

  // The buyer is left holding only sealed data. Without the (unrevealed) key it
  // cannot be opened, and the key never touched the server for the buyer to lift.
  const cannotOpen = await decryptAndVerify({
    sessionId: stuck.id,
    dealId: stuck.dealId,
    blob,
    dek: generateDek(), // the buyer does NOT have the real DEK
    dekSalt,
    dekCommit: stuck.dekCommit,
    chunkSize: stuck.chunkSize,
    chunkCount: stuck.chunkCount,
    plaintextRoot: stuck.plaintextRoot,
  });
  expect(cannotOpen.ok).toBe(false);

  // COUNTERFACTUAL: nobody can forge a later step without the prior event hash.
  // The seller signs a well-formed dek_revealed but links it to a WRONG prev
  // hash (not the chain tip); the server refuses to graft it onto the chain.
  const forgedNext = {
    ...nextLeaf(stuck, "seller", SELLER.handle, "dek_revealed", { dekCommit: stuck.dekCommit }),
    prevHash: "a".repeat(64),
  };
  const forgedRes = await postSigned(
    sellerCtx.request,
    `${BASE}/api/exchange/${sessionId}/events`,
    forgedNext,
    sellerKeys,
  );
  expect([400, 409], "a step not linked to the tip is refused").toContain(forgedRes.status());
  // and a locally relinked chain fails re-verification.
  const relinked = stuck.events.map((e, i) => (i === 2 ? { ...e, prevHash: "b".repeat(64) } : e));
  expect(verifyChain(stuck.id, stuck.dealId, relinked).ok).toBe(false);
});

/* ================================================= PRIVACY across surfaces */

/** Every number value reachable in a parsed structure (strings are skipped). */
function numbersIn(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number") out.push(v);
  else if (Array.isArray(v)) for (const x of v) numbersIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) numbersIn(x, out);
  return out;
}

test("PRIVACY-ALL exchange, receipts and the translog carry no data, no key, no exact amount, no name", async () => {
  const c = db();
  const sessions = await c.execute("SELECT * FROM exchange_sessions");
  const events = await c.execute("SELECT * FROM exchange_events");
  const sigs = await c.execute("SELECT * FROM deal_receipt_signatures");
  const leaves = await c.execute("SELECT payload_json FROM translog_leaves");
  c.close();

  const stringDump =
    JSON.stringify(sessions.rows) +
    JSON.stringify(events.rows) +
    JSON.stringify(sigs.rows) +
    JSON.stringify(leaves.rows) +
    sigToken;

  // NO dataset bytes anywhere (the demo blob is opaque AEAD ciphertext).
  for (const tok of ["signups", "revenue_usd", `SECRET_MARKER_${RUN}`]) {
    expect(stringDump.includes(tok), `dataset token "${tok}" absent`).toBe(false);
  }
  // NO DEK: even the completed flow's key never reached the server.
  expect(stringDump.includes(toB64url(live.dek)), "the DEK never reaches the server").toBe(false);

  // NO buyer name, NO real name, NO contact: never stored in any form.
  for (const pii of [DEAL.buyer, SELLER.realName, BUYER.realName, SELLER.contact, BUYER.contact]) {
    expect(stringDump.includes(pii), `PII "${pii}" absent`).toBe(false);
  }

  // NO raw amount: buckets only. Check numeric FIELDS (not substrings, which
  // would false-hit hex hashes) across the translog payloads, the exchange rows
  // (and their signed leaves), the signature rows, and the receipt payload.
  const nums = new Set<number>();
  for (const r of leaves.rows) numbersIn(JSON.parse(String(r.payload_json)), []).forEach((n) => nums.add(n));
  for (const r of [...sessions.rows, ...sigs.rows]) numbersIn(r, []).forEach((n) => nums.add(n));
  for (const r of events.rows) {
    numbersIn(r, []).forEach((n) => nums.add(n));
    numbersIn(JSON.parse(String((r as Record<string, unknown>).payload_json)), []).forEach((n) => nums.add(n));
  }
  numbersIn(decodeReceipt(sigToken), []).forEach((n) => nums.add(n));
  for (const amt of [DEAL.total, DEAL.myShare, DEAL.partShare]) {
    expect(nums.has(Number(amt)), `exact amount ${amt} appears in no numeric field`).toBe(false);
  }

  // What IS carried is a bucket, never the figure.
  const p = decodeReceipt(sigToken);
  expect(p.amountBucket).toMatch(/^(<\$10k|\$[\d.]+[kM])$/);
  expect(p.amountBucket.includes(DEAL.total)).toBe(false);
});

async function fetchSession(api: APIRequestContext, id: string): Promise<SessionView> {
  const res = await api.get(`${BASE}/api/exchange/${id}`);
  expect(res.status(), `GET session ${id}`).toBe(200);
  return (await res.json()).session as SessionView;
}
