/**
 * tests/cryptofix.spec.ts
 *
 * Regression proofs for the confirmed cryptographic findings (audit/AUDIT-RESULTS.md,
 * audit/FIX-PLAN.md). Every test proves a finding is CLOSED with a BEFORE/AFTER
 * counterfactual: it demonstrates the attack the OLD code path allowed, then that
 * the SAME move fails against the fixed code. A green here without the counterfactual
 * would be a strawman, so each guard is made to fail on the pre-fix behaviour on
 * purpose.
 *
 *   F-01a  the public per-handle signing-key directory is session-gated now (the
 *          offline password oracle is closed to the internet), and /receipts/verify
 *          still verifies a receipt logged out, from the pubkeys it carries.
 *   F-01b  a served signing pubkey is NO LONGER recomputable from (password, handle)
 *          alone: the per-user server salt is required, and it is delivered only
 *          inside that user's own authenticated response. WITH the salt the
 *          derivation still matches (deterministic per device).
 *   F-01c  passwordProblem rejects a sub-floor / obviously-weak password that the
 *          old 10-char floor accepted, and accepts a real passphrase.
 *   F-02   /api/asks/similar is a hard-throttled count oracle (ceiling well below the
 *          evaluate limit); the evaluate route + transparency copy no longer claim
 *          the rate limit is a pseudonymity control.
 *   N-01   fromB64url rejects a non-canonical base64url encoding that decodes to the
 *          same bytes as the canonical one (string<->bytes is 1:1 again).
 *   N-02   a signature made in one context (receipt-attest) does not verify in
 *          another (exchange-event / wire-claim); the old un-framed signing let it.
 *   N-04   mutating a receipt field the old base did not cover (buyerIsOther, the
 *          full participant roster) now breaks every party signature.
 *   HARD   a malleable Ed25519 signature (S+L) that a non-strict verifier accepts is
 *          rejected under the code's strict verify; the exchange DEK key-commitment
 *          rejects a revealed key that does not match the commitment.
 *   PRIV   the full DB dump is clean and user_kdf_salt holds only a random salt.
 *
 * PRECONDITION: freshly reset + seeded DB and the built app on port 3947:
 *   SERVER_PEPPER=... npm run reset-db && npm run seed
 *   CI=1 SERVER_PEPPER=... npx playwright test tests/cryptofix.spec.ts
 */

import { test, expect, type Browser } from "@playwright/test";
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";

import {
  toB64url,
  fromB64url,
  deriveSigningKeys,
  domainSeparatedSigningBytes,
} from "../lib/e2ee";
import {
  type PartyBaseFields,
  sortSigners,
  partySigningBase,
  signReceiptBase,
  verifyPartySig,
  verifyAttestation,
} from "../lib/receipt-attest";
import {
  RECEIPT_VERSION,
  encodeReceipt,
  partyBaseFieldsFromPayload,
  canonicalJson,
  type ReceiptPayload,
} from "../lib/receipts";
import {
  EXCHANGE_VERSION,
  GENESIS_PREV_HASH,
  newSessionId,
  generateDek,
  encryptDataset,
  decryptAndVerify,
  dekCommitHex,
  signLeaf,
  verifyLeafSignature,
  leafBytes,
  type ExchangeLeaf,
  type WireClaimLeaf,
} from "../lib/exchange";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "../lib/crypto";
import { RATE_LIMITS } from "../lib/ratelimit";

const ROOT = path.resolve(__dirname, "..");
const DB_URL = process.env.BLIND_TENDER_DB ?? `file:${path.join(ROOT, "data", "app.db")}`;
const PORT = Number(process.env.PW_PORT ?? 3947);
const BASE = `http://localhost:${PORT}`;

const DEMO = "demo-demo-demo"; // every seeded account's password (scripts/seed.ts)

/* the three documented signing-context domain tags (lib/receipt-attest.ts, lib/exchange.ts) */
const RECEIPT_TAG = "databoard/receipt-attest/v1";
const EXCHANGE_TAG = "databoard/exchange-event/v1";
const WIRE_TAG = "databoard/wire-claim/v1";

/* ------------------------------------------------------------------ helpers */

function db() {
  return createClient({ url: DB_URL });
}

async function clearRateLimits() {
  const c = db();
  await c.execute("DELETE FROM rate_limits");
  c.close();
}

async function login(browser: Browser, username: string, password: string, ip: string) {
  const ctx = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { "x-forwarded-for": ip },
  });
  const res = await ctx.request.post(`${BASE}/api/auth/login`, { data: { username, password } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { username: string; kdfSalt?: string };
  return { ctx, kdfSalt: body.kdfSalt };
}

const enc = new TextEncoder();
// ES2017 target: no bigint literals, so name the constants we need.
const B0 = BigInt(0);
const B8 = BigInt(8);
const BFF = BigInt(0xff);
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function leToBig(b: Uint8Array): bigint {
  let x = B0;
  for (let i = b.length - 1; i >= 0; i--) x = (x << B8) | BigInt(b[i]);
  return x;
}
function bigToLe(x: bigint, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let v = x;
  for (let i = 0; i < n; i++) {
    out[i] = Number(v & BFF);
    v >>= B8;
  }
  return out;
}

const CURVE_L = ed25519.Point.Fn.ORDER;

/**
 * A cofactorless Ed25519 verify that omits the canonical-S bound (0 <= S < L):
 * exactly the naive/non-strict verifier the code's strict `{ zip215: false }`
 * check replaces. It accepts a signature's malleable twin S+L, which strict
 * verify rejects. Used only to demonstrate the BEFORE behaviour.
 */
function naiveCofactorlessVerify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  try {
    const R = sig.slice(0, 32);
    const s = ((leToBig(sig.slice(32, 64)) % CURVE_L) + CURVE_L) % CURVE_L;
    const h = leToBig(sha512(concatBytes(R, pub, msg))) % CURVE_L;
    const Rp = ed25519.Point.fromBytes(R);
    const Ap = ed25519.Point.fromBytes(pub);
    const left = s === B0 ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(s);
    const right = Rp.add(h === B0 ? ed25519.Point.ZERO : Ap.multiply(h));
    return left.equals(right);
  } catch {
    return false;
  }
}

/** A well-formed set of party-base fields to sign over (values are metadata, not PII). */
function baseFields(over: Partial<PartyBaseFields> = {}): PartyBaseFields {
  return {
    dealId: "deal_cryptofix",
    tier: "co_attested",
    buyerToken: "v2:" + "0".repeat(128),
    amountBucket: "$90k",
    buyerIsOther: false,
    schemaSha256: "b".repeat(64),
    commit: null,
    attestedAt: 1_700_000_000_000,
    seq: 22,
    participants: ["cfa", "cfb"],
    signers: [],
    ...over,
  };
}

function exchangeLeaf(over: Partial<ExchangeLeaf> = {}): ExchangeLeaf {
  return {
    v: EXCHANGE_VERSION,
    sessionId: "exch_cryptofix000000000",
    dealId: "deal_cryptofix",
    seq: 1,
    type: "commit",
    actorRole: "seller",
    actor: "cfa",
    prevHash: GENESIS_PREV_HASH,
    ts: 1_700_000_000_000,
    data: {
      plaintextRoot: "0".repeat(64),
      ciphertextRoot: "1".repeat(64),
      dekCommit: "2".repeat(64),
      dekSalt: "AA",
      chunkCount: 1,
      chunkSize: 256,
      sizeBucket: "<1 MB",
      buyer: "cfb",
    },
    ...over,
  };
}

/* ============================================================ F-01c passwords */

test("F-01c passwordProblem rejects sub-floor and obviously-weak passwords the old 10-char floor let through", () => {
  // The floor was raised well above the old 10 (audit F-01c).
  expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(14);
  expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(10);

  // AFTER: a strong passphrase is accepted ("a sentence works" stays true).
  expect(passwordProblem("correct horse battery staple")).toBeNull();

  // Sub-floor is refused.
  expect(passwordProblem("short")).not.toBeNull();

  // COUNTERFACTUAL (floor raise): a 10-char string cleared the OLD floor (>= 10)
  // but is refused now. Assert it really is >= the old floor, so the rejection is
  // the raised floor and not some other rule.
  const tenChars = "abcdefghij";
  expect(tenChars.length).toBeGreaterThanOrEqual(10); // would have passed the old floor
  expect(passwordProblem(tenChars)).not.toBeNull(); // fails now

  // COUNTERFACTUAL (new weak/entropy check): a 16-char textbook-weak password is
  // ABOVE the new length floor, so only the new weak-list check can reject it. The
  // old code had no such check and would have accepted it.
  const weakButLong = "passwordpassword";
  expect(weakButLong.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  expect(passwordProblem(weakButLong)).not.toBeNull();

  // A long but tiny-alphabet string is refused by the entropy check.
  expect(passwordProblem("aaaaaaaaaaaaaaaa")).not.toBeNull();
});

/* ============================================================ N-01 base64url */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Decode base64url dropping trailing bits, with NO canonical round-trip check: the old fromB64url. */
function looseDecode(s: string): Uint8Array {
  const len = Math.floor((s.length * 3) / 4);
  const out = new Uint8Array(len);
  let buffer = 0;
  let bits = 0;
  let j = 0;
  for (const ch of s) {
    const v = B64_ALPHABET.indexOf(ch);
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

test("N-01 a non-canonical base64url that decodes to the same bytes is rejected where the canonical one is accepted", async () => {
  const keys = await deriveSigningKeys("n01-tester", "correct horse battery staple one");
  const canonical = keys.publicKey; // 43 chars, a 32-byte key
  expect(canonical).toHaveLength(43);

  // Build a NON-canonical twin: change the last char to another whose top 4 bits
  // match (only the low 2 bits are dropped for a 43-char / 32-byte value), so it
  // decodes to the same bytes but is a different string.
  const lastIdx = B64_ALPHABET.indexOf(canonical[42]);
  const twinIdx = [0, 1, 2, 3]
    .map((d) => (lastIdx & 0b111100) | d)
    .find((i) => i !== lastIdx && i >> 2 === lastIdx >> 2)!;
  const noncanon = canonical.slice(0, 42) + B64_ALPHABET[twinIdx];
  expect(noncanon).not.toBe(canonical);

  // COUNTERFACTUAL: the OLD loose decoder maps the two DISTINCT strings to the SAME
  // 32 bytes, so the string form of a key was malleable.
  const a = looseDecode(canonical);
  const b = looseDecode(noncanon);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

  // AFTER: fromB64url accepts the canonical form and REJECTS the non-canonical twin.
  const decodedCanonical = fromB64url(canonical);
  expect(decodedCanonical).not.toBeNull();
  expect(decodedCanonical!.length).toBe(32);
  expect(fromB64url(noncanon)).toBeNull();

  // The rejection propagates to the verification layer: a real signature verifies
  // under the canonical pubkey and is refused under the non-canonical encoding of
  // the SAME key. (Same for the signature string.)
  const base = partySigningBase(baseFields());
  const sig = signReceiptBase(base, keys.secretKey);
  expect(verifyPartySig(base, canonical, sig)).toBe(true);
  expect(verifyPartySig(base, noncanon, sig)).toBe(false);

  const sigLastIdx = B64_ALPHABET.indexOf(sig[sig.length - 1]);
  const sigTwinIdx = [0, 1, 2, 3]
    .map((d) => (sigLastIdx & 0b111100) | d)
    .find((i) => i !== sigLastIdx && i >> 2 === sigLastIdx >> 2)!;
  const noncanonSig = sig.slice(0, sig.length - 1) + B64_ALPHABET[sigTwinIdx];
  expect(noncanonSig).not.toBe(sig);
  expect(Buffer.from(looseDecode(noncanonSig)).equals(Buffer.from(looseDecode(sig)))).toBe(true);
  expect(verifyPartySig(base, canonical, noncanonSig)).toBe(false); // canonical sig accepted above
});

/* ============================================================ N-02 domain sep */

test("N-02 a signature in one context does not verify in another; the old un-framed signing let it", async () => {
  const keys = await deriveSigningKeys("n02-tester", "correct horse battery staple two");
  const sk = keys.secretKey;
  const pub = ed25519.getPublicKey(sk);
  const body = '{"a":1,"z":"payload"}';

  // The real signing functions frame with the three DISTINCT documented tags.
  expect(signReceiptBase(body, sk)).toBe(
    toB64url(ed25519.sign(domainSeparatedSigningBytes(RECEIPT_TAG, body), sk)),
  );
  const exLeaf = exchangeLeaf();
  expect(signLeaf(exLeaf, sk)).toBe(
    toB64url(ed25519.sign(domainSeparatedSigningBytes(EXCHANGE_TAG, leafBytes(exLeaf)), sk)),
  );
  const wireLeaf: WireClaimLeaf = {
    v: EXCHANGE_VERSION,
    sessionId: "exch_cryptofix000000000",
    dealId: "deal_cryptofix",
    seq: 1,
    type: "wire_credit_claim",
    actorRole: "seller",
    actor: "cfa",
    prevHash: "d".repeat(64),
    ts: 1_700_000_000_000,
    data: { n15: "0".repeat(15) },
  };
  expect(signLeaf(wireLeaf, sk)).toBe(
    toB64url(ed25519.sign(domainSeparatedSigningBytes(WIRE_TAG, leafBytes(wireLeaf)), sk)),
  );

  // A receipt-context signature over `body` verifies under the receipt frame...
  const msgReceipt = domainSeparatedSigningBytes(RECEIPT_TAG, body);
  const sigReceipt = ed25519.sign(msgReceipt, sk);
  expect(ed25519.verify(sigReceipt, msgReceipt, pub, { zip215: false })).toBe(true);
  // ...and does NOT verify when re-presented under the exchange or wire frame.
  expect(
    ed25519.verify(sigReceipt, domainSeparatedSigningBytes(EXCHANGE_TAG, body), pub, {
      zip215: false,
    }),
  ).toBe(false);
  expect(
    ed25519.verify(sigReceipt, domainSeparatedSigningBytes(WIRE_TAG, body), pub, {
      zip215: false,
    }),
  ).toBe(false);

  // Through the real verifiers: a receipt-attest signature over an exchange leaf's
  // exact bytes is refused by verifyLeafSignature (and the converse).
  const leafBody = leafBytes(exLeaf);
  const receiptSigOverLeafBody = signReceiptBase(leafBody, sk); // signed under the RECEIPT frame
  expect(verifyLeafSignature(exLeaf, receiptSigOverLeafBody, keys.publicKey)).toBe(false);
  const exSig = signLeaf(exLeaf, sk); // signed under the EXCHANGE frame
  expect(verifyLeafSignature(exLeaf, exSig, keys.publicKey)).toBe(true);
  expect(verifyPartySig(leafBody, keys.publicKey, exSig)).toBe(false);

  // COUNTERFACTUAL: the OLD scheme signed the raw body with NO context frame, so a
  // single signature was valid in EVERY context (the same bytes). Show the raw sig
  // verifies against the un-framed body regardless of intended context.
  const rawSig = ed25519.sign(enc.encode(body), sk);
  expect(ed25519.verify(rawSig, enc.encode(body), pub, { zip215: false })).toBe(true);
  // The framed contexts all differ from the raw body, so framing is what breaks the lift.
  expect(Buffer.from(msgReceipt).equals(Buffer.from(enc.encode(body)))).toBe(false);
});

/* ============================================================ N-04 field binding */

test("N-04 mutating a receipt field the old base did not cover now breaks every party signature", async () => {
  const kA = await deriveSigningKeys("cfa", "correct horse battery staple a");
  const kB = await deriveSigningKeys("cfb", "correct horse battery staple b");
  const signers = sortSigners([
    { handle: "cfa", pubkey: kA.publicKey },
    { handle: "cfb", pubkey: kB.publicKey },
  ]);
  const fields = baseFields({ signers, buyerIsOther: false, participants: ["cfa", "cfb"] });
  const base = partySigningBase(fields);
  const sigs = [
    { handle: "cfa", sig: signReceiptBase(base, kA.secretKey) },
    { handle: "cfb", sig: signReceiptBase(base, kB.secretKey) },
  ];

  // Baseline: both party signatures verify.
  const ok = verifyAttestation(fields, sigs);
  expect(ok.allSigned).toBe(true);
  expect(ok.valid.sort()).toEqual(["cfa", "cfb"]);

  // AFTER: flip buyerIsOther (a field the old v1 base did NOT commit) -> the
  // recomputed base changes and every signature fails.
  const flippedField = { ...fields, buyerIsOther: true };
  const vFlip = verifyAttestation(flippedField, sigs);
  expect(vFlip.allSigned).toBe(false);
  expect(vFlip.valid).toEqual([]);

  // AFTER: drop a non-signing participant from the FULL roster (old base covered
  // only the signing subset) -> signatures fail.
  const droppedParticipant = { ...fields, participants: ["cfa", "cfb", "cfc"] };
  const vDrop = verifyAttestation(droppedParticipant, sigs);
  expect(vDrop.allSigned).toBe(false);

  // COUNTERFACTUAL: reconstruct the OLD v1 base (no buyerIsOther, no participants,
  // signers-only) and its OLD un-framed signature. The old base is byte-identical
  // whether buyerIsOther is true or false, so an old-style signature keeps
  // verifying over the mutated receipt: the operator could flip the field undetected.
  function oldBaseV1(f: PartyBaseFields): string {
    return canonicalJson({
      v: 1,
      dealId: f.dealId,
      tier: f.tier,
      buyerToken: f.buyerToken,
      amountBucket: f.amountBucket,
      attestedAt: f.attestedAt,
      seq: f.seq,
      signers: sortSigners(f.signers),
    });
  }
  const ob = oldBaseV1(fields);
  const obFlipped = oldBaseV1({ ...fields, buyerIsOther: true, participants: ["cfa", "cfb", "cfc"] });
  expect(ob).toBe(obFlipped); // the old base did not cover either mutated field
  const oldSigA = ed25519.sign(enc.encode(ob), kA.secretKey); // old: no domain frame
  expect(ed25519.verify(oldSigA, enc.encode(obFlipped), ed25519.getPublicKey(kA.secretKey))).toBe(true);
});

/* ====================================================== HARDENING malleability + DEK */

test("HARDENING a malleable Ed25519 signature (S+L) is rejected under strict verify though a non-strict verifier accepts it", async () => {
  const keys = await deriveSigningKeys("hard-tester", "correct horse battery staple hh");
  const sk = keys.secretKey;
  const pub = ed25519.getPublicKey(sk);

  const leaf = exchangeLeaf();
  const sigB64 = signLeaf(leaf, sk);
  expect(verifyLeafSignature(leaf, sigB64, keys.publicKey)).toBe(true);

  const sig = fromB64url(sigB64)!;
  const msg = domainSeparatedSigningBytes(EXCHANGE_TAG, leafBytes(leaf));
  // Sanity: the naive verifier accepts the genuine signature (so it is a fair oracle).
  expect(naiveCofactorlessVerify(sig, msg, pub)).toBe(true);

  // The malleable twin S' = S + L: a distinct 64-byte signature, equal mod L.
  const S = leToBig(sig.slice(32, 64));
  const malSig = new Uint8Array(64);
  malSig.set(sig.slice(0, 32), 0);
  malSig.set(bigToLe(S + CURVE_L, 32), 32);
  expect(Buffer.from(malSig).equals(Buffer.from(sig))).toBe(false);
  expect((S + CURVE_L) % CURVE_L).toBe(S); // genuine malleability, not garbage

  // COUNTERFACTUAL: a non-strict (no S<L bound) verifier ACCEPTS the twin.
  expect(naiveCofactorlessVerify(malSig, msg, pub)).toBe(true);

  // AFTER: the code's strict verify REJECTS it, in the exchange path...
  expect(verifyLeafSignature(leaf, toB64url(malSig), keys.publicKey)).toBe(false);
  // ...and in the receipt path.
  const base = partySigningBase(baseFields());
  const rSigB64 = signReceiptBase(base, sk);
  expect(verifyPartySig(base, keys.publicKey, rSigB64)).toBe(true);
  const rSig = fromB64url(rSigB64)!;
  const rMal = new Uint8Array(64);
  rMal.set(rSig.slice(0, 32), 0);
  rMal.set(bigToLe(leToBig(rSig.slice(32, 64)) + CURVE_L, 32), 32);
  expect(verifyPartySig(base, keys.publicKey, toB64url(rMal))).toBe(false);
});

test("HARDENING the exchange DEK commitment binds the key and the ciphertext: a wrong revealed key is rejected", async () => {
  const sessionId = newSessionId();
  const dealId = "deal_dek_commit";
  const data = enc.encode("row,region,value\n1,emea,42\n2,amer,99\n");
  const dek = generateDek();
  const salt = new Uint8Array(16).fill(5);
  const encd = await encryptDataset(sessionId, data, dek, 256);
  const commit = dekCommitHex(dealId, encd.ciphertextRoot, salt, dek);

  // Right key: verifies and decrypts.
  const good = await decryptAndVerify({
    sessionId,
    dealId,
    blob: encd.ciphertext,
    dek,
    dekSalt: salt,
    dekCommit: commit,
    chunkSize: encd.chunkSize,
    chunkCount: encd.chunkCount,
    plaintextRoot: encd.plaintextRoot,
  });
  expect(good.ok).toBe(true);

  // AFTER: a different revealed key is caught by the commitment before it can be used.
  const wrong = await decryptAndVerify({
    sessionId,
    dealId,
    blob: encd.ciphertext,
    dek: generateDek(),
    dekSalt: salt,
    dekCommit: commit,
    chunkSize: encd.chunkSize,
    chunkCount: encd.chunkCount,
    plaintextRoot: encd.plaintextRoot,
  });
  expect(wrong.ok).toBe(false);
  if (!wrong.ok) expect(wrong.error).toBe("bad_dek");

  // The commitment is key-committing AND ciphertext-committing: a second key, or a
  // swapped ciphertext root, yields a different commitment (so neither can be
  // substituted under the same commit).
  expect(dekCommitHex(dealId, encd.ciphertextRoot, salt, generateDek())).not.toBe(commit);
  expect(dekCommitHex(dealId, "f".repeat(64), salt, dek)).not.toBe(commit);
});

/* ============================================================ F-01a directory gate */

test("F-01a the signing-key directory is session-gated; /receipts/verify still verifies logged out from embedded pubkeys", async ({
  request,
  browser,
}) => {
  // ANON directory read is bounced (middleware redirect or 401), never answered:
  // the offline oracle is closed to the internet.
  const anon = await request.get(`${BASE}/api/signing/pubkey?handle=marble-pennant`, {
    maxRedirects: 0,
  });
  expect(anon.status(), "anon directory read must not be 200").not.toBe(200);
  expect([301, 302, 303, 307, 308, 401]).toContain(anon.status());

  // The per-user salt is likewise never served without that user's own session.
  const anonSalt = await request.get(`${BASE}/api/auth/kdf-salt`, { maxRedirects: 0 });
  expect(anonSalt.status()).toBe(401);

  // COUNTERFACTUAL: with a session the SAME directory read succeeds (the data the
  // oracle needed) -> the gate, not a broken route, is what stops the anon read.
  const { ctx } = await login(browser, "marble-pennant", DEMO, "198.51.100.71");
  const authed = await ctx.request.get(`${BASE}/api/signing/pubkey?handle=marble-pennant`);
  expect(authed.status()).toBe(200);
  const authedPubkey = (await authed.json()).pubkey as string;
  expect(authedPubkey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await ctx.close();

  // A genuine co-attested, party-signed receipt built with this instance's pepper.
  const kA = await deriveSigningKeys("rva", "correct horse battery staple rva");
  const kB = await deriveSigningKeys("rvb", "correct horse battery staple rvb");
  const signers = sortSigners([
    { handle: "rva", pubkey: kA.publicKey },
    { handle: "rvb", pubkey: kB.publicKey },
  ]);
  const payload: ReceiptPayload = {
    v: RECEIPT_VERSION,
    dealId: "deal_rv_public",
    tier: "co_attested",
    participants: ["rva", "rvb"],
    buyerToken: "v2:" + "0".repeat(128),
    buyerIsOther: false,
    amountBucket: "$90k",
    attestedAt: 1_700_000_000_000,
    schemaSha256: "b".repeat(64),
    commit: null,
    log: { seq: 22, leafHash: "a".repeat(64) },
    attest: { signers, sigs: [] },
  };
  const fields = partyBaseFieldsFromPayload(payload)!;
  const base = partySigningBase(fields);
  payload.attest!.sigs = [
    { handle: "rva", sig: signReceiptBase(base, kA.secretKey) },
    { handle: "rvb", sig: signReceiptBase(base, kB.secretKey) },
  ];
  const token = encodeReceipt(payload);

  // Logged OUT (no cookies on the `request` fixture), /api/receipts/verify verifies
  // the platform MAC...
  const vr = await request.post(`${BASE}/api/receipts/verify`, { data: { token } });
  expect(vr.status()).toBe(200);
  expect((await vr.json()).valid, "receipt verifies with no session").toBe(true);

  // ...and the party layer verifies from the pubkeys the RECEIPT ITSELF carries,
  // with no directory read and no session, exactly as the public verifier page does.
  const v = verifyAttestation(fields, payload.attest!.sigs);
  expect(v.allSigned).toBe(true);
  expect(v.valid.sort()).toEqual(["rva", "rvb"]);
});

/* ============================================================ F-01b salt oracle */

test("F-01b a served signing pubkey is not recomputable from password+handle alone; the server salt is required", async ({
  browser,
}) => {
  const { ctx, kdfSalt } = await login(browser, "granite-fox", DEMO, "198.51.100.72");
  expect(typeof kdfSalt, "login delivers the per-user salt after the password check").toBe("string");
  expect((kdfSalt ?? "").length).toBeGreaterThan(0);

  const dir = await ctx.request.get(`${BASE}/api/signing/pubkey?handle=granite-fox`);
  expect(dir.status()).toBe(200);
  const served = (await dir.json()).pubkey as string;
  expect(served).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // COUNTERFACTUAL: the OLD offline oracle recomputed the pubkey from (password,
  // handle) alone. Do exactly that with the KNOWN seeded password -> it must NOT
  // match now, because the server salt is folded in.
  const noSalt = await deriveSigningKeys("granite-fox", DEMO);
  expect(noSalt.publicKey, "pubkey is no longer a pure function of (password, handle)").not.toBe(
    served,
  );

  // WITH the salt (delivered only inside this user's own authenticated response) the
  // recomputation DOES match: the derivation is still deterministic per device.
  const withSalt = await deriveSigningKeys("granite-fox", DEMO, kdfSalt);
  expect(withSalt.publicKey, "with the server salt the derivation is deterministic").toBe(served);

  await ctx.close();
});

/* ============================================================ F-02 similar oracle */

test("F-02 /api/asks/similar is a hard-throttled count oracle, well below the evaluate ceiling", async ({
  browser,
}) => {
  // The ceiling is a fraction of the evaluate limit (F-02 oracle hygiene).
  expect(RATE_LIMITS.similarPerUser.limit).toBeLessThan(RATE_LIMITS.voprfPerUser.limit);
  expect(RATE_LIMITS.similarPerUser.limit).toBeLessThanOrEqual(8);

  await clearRateLimits();
  const { ctx } = await login(browser, "vellum", DEMO, "198.51.100.73");
  const token = "v2:" + "a".repeat(128); // an arbitrary, format-valid token the caller did not mint

  const N = RATE_LIMITS.similarPerUser.limit + 6;
  const statuses: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = await ctx.request.get(`${BASE}/api/asks/similar?token=${token}`);
    statuses.push(r.status());
  }
  await ctx.close();

  const ok = statuses.filter((s) => s === 200).length;
  const limited = statuses.filter((s) => s === 429).length;
  // No more successful counts than the hard ceiling, and the wall is hit fast.
  expect(ok).toBeLessThanOrEqual(RATE_LIMITS.similarPerUser.limit);
  expect(limited).toBeGreaterThan(0);
  // COUNTERFACTUAL: the same burst under the evaluate ceiling (30/min) would have
  // answered every call; here the count oracle refuses well before that.
  expect(N).toBeLessThanOrEqual(RATE_LIMITS.voprfPerUser.limit); // burst is under the evaluate limit
  expect(ok).toBeLessThan(N); // yet it is throttled anyway
});

test("F-02 copy: the evaluate route and transparency pages say the rate limit is NOT a pseudonymity control", async ({
  request,
}) => {
  // Rendered, public transparency copy (what a reader actually sees).
  for (const p of ["/transparency", "/transparency/verification"]) {
    const res = await request.get(`${BASE}${p}`);
    expect(res.status(), p).toBe(200);
    const html = (await res.text()).replace(/\s+/g, " ").toLowerCase();
    expect(html, `${p} carries the honest wording`).toContain(
      "cost control, not a pseudonymity control",
    );
  }

  // The evaluate route comment: honest wording present, old overclaim absent.
  const src = readFileSync(path.join(ROOT, "app/api/voprf/evaluate/route.ts"), "utf8");
  expect(src).toContain("a pseudonymity control");
  expect(src).toMatch(/DoS\/cost control/);
  // The exact pre-fix overclaim must be gone.
  expect(src).not.toContain("the only thing that makes offline");
});

/* ============================================================ PRIVACY */

test("PRIVACY user_kdf_salt holds only a random per-user salt, and the full dump is clean", async () => {
  const c = db();
  const rows = (await c.execute("SELECT * FROM user_kdf_salt")).rows;
  const tables = (
    await c.execute("SELECT name FROM sqlite_master WHERE type='table'")
  ).rows.map((r) => String(r.name));
  let fullDump = "";
  for (const t of tables) {
    const rs = await c.execute(`SELECT * FROM ${t}`);
    fullDump += JSON.stringify(rs.rows);
  }
  c.close();

  // The table exists and was populated by the seed.
  expect(rows.length).toBeGreaterThan(0);
  // Exactly three columns: an opaque user id, the salt, a timestamp. Nothing else.
  expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "salt", "user_id"]);

  // Each salt is high-entropy random bytes (32 bytes, base64url), and salts are unique.
  const seen = new Set<string>();
  for (const r of rows) {
    const s = String(r.salt);
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url, no padding
    const bytes = fromB64url(s);
    expect(bytes && bytes.length, "salt decodes to 32 bytes").toBe(32);
    expect(new Set(bytes!).size, "salt is not low-entropy").toBeGreaterThan(12);
    seen.add(s);
  }
  expect(seen.size, "salts are unique per user").toBe(rows.length);

  // COUNTERFACTUAL / PII sweep: the raw password and raw contact fragments must
  // appear in NO row of ANY table. The password is only ever a scrypt hash; a
  // contact is only ever a blind index. If a fix had started persisting either,
  // these would hit.
  for (const marker of ["demo-demo-demo", "example.com", "4155550101", "4155550102"]) {
    expect(fullDump.includes(marker), `PII/secret marker "${marker}" must not appear`).toBe(false);
  }
});
