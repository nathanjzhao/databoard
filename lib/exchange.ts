/**
 * lib/exchange.ts
 *
 * Commit-encrypt-pay-reveal dataset exchange (Tier A), as ONE isomorphic
 * module. Every cryptographic primitive here runs unchanged in the browser
 * (the /deals/[id]/exchange stepper), under plain node (the proof suite), and
 * on the server (which calls only the VERIFY half, because it holds no keys
 * and can open nothing).
 *
 * WHAT THE PROTOCOL IS, in full. A deal on the board records that some sellers
 * sold data to a buyer. This protocol is the actual dataset handoff between
 * two accounts on that deal, built so neither has to trust the other or the
 * operator with the data:
 *
 *   1. COMMIT (seller).  The seller chunks the dataset in their browser,
 *      AEAD-encrypts each chunk under a per-deal key (the DEK), and builds two
 *      Merkle manifests: one over the PLAINTEXT chunk hashes, one over the
 *      CIPHERTEXT chunk hashes. They commit plaintext_root, ciphertext_root,
 *      and dek_commit = SHA-256(domain || deal_id || ciphertext_root || salt ||
 *      DEK) - a hash of the key, never the key. Binding the ciphertext_root INTO
 *      the key commitment makes it key-committing over the exact ciphertext
 *      (AES-GCM is not key-committing on its own): a committed ciphertext binds
 *      to exactly one revealed key. The seller SIGNS this commitment. The server
 *      stores the commitment and the signature; it never sees the data or the
 *      DEK.
 *   2. DELIVER (seller, off-chain).  The encrypted chunks move to the buyer:
 *      off-platform, or through the E2EE thread as ciphertext, or - for the
 *      demo - through a size-capped opaque blob the server treats as bytes it
 *      cannot read. No signature; it is just bytes.
 *   3. CIPHERTEXT ACK (buyer).  The buyer recomputes the ciphertext root from
 *      what they received and SIGNS "ciphertext received, matches commitment".
 *      They are now holding sealed data they cannot yet open.
 *   4. PAYMENT SIGNALED (buyer).  The buyer pays off-platform and SIGNS a
 *      payment-reference COMMITMENT (a hash, no amount, no raw reference).
 *   5. DEK REVEAL (seller).  The seller sends the DEK to the buyer (off the
 *      exchange server) and SIGNS "the DEK matching dek_commit is revealed".
 *      The server still never sees the DEK.
 *   6. COMPLETE (buyer).  The buyer checks SHA-256(...DEK) == dek_commit,
 *      decrypts, verifies the plaintext against plaintext_root, and SIGNS
 *      "plaintext verified". Terminal.
 *
 * Either party may ABORT a non-terminal session with a signed abort.
 *
 * Every step is a hash-linked, signed leaf (buildEventLeaf / signEvent):
 * event N carries prevHash = eventHash(N-1), so the sequence is tamper-evident,
 * and each leaf is Ed25519-signed by the acting party over its canonical bytes,
 * so a valid chain proves the NAMED PARTIES THEMSELVES took each step, in order.
 *
 * WHAT THE SERVER CAN AND CANNOT SEE.
 *   CAN:    deal id, the two pseudonymous handles, the Merkle roots (hashes of
 *           hashes), dek_commit (a hash), chunk_count / chunk_size, a coarse
 *           size bucket, a payment-reference commitment (a hash), every
 *           signature and signing pubkey, the state, timestamps, and - on the
 *           demo path only - an opaque AEAD blob it cannot decrypt.
 *   CANNOT: the dataset, the DEK, the AEAD keys, the exact byte size (only a
 *           bucket), the payment amount (only that payment was signaled), the
 *           raw payment reference, or any chunk plaintext.
 *
 * HONEST BOUND, stated here and on /transparency/verification and in
 * docs/EXCHANGE.md: atomic fair exchange of data for payment between two
 * mutually-distrusting parties is impossible without a blockchain or an escrow
 * agent (Pagnia-Gaertner). This does NOT make the exchange atomic. It BOUNDS
 * and EVIDENCES cheating: a party that stops after receiving is provable from
 * the signed chain, and chunking caps the exposure of a stop-after-receiving
 * to one chunk. Real atomicity is Tier B (on-chain escrow), not built here.
 *
 * Dependencies: @noble/hashes (SHA-256, and lib/merkle.ts for the RFC 6962
 * roots) and @noble/curves (Ed25519), plus WebCrypto AES-GCM (globalThis.
 * crypto.subtle, present in every browser and in node 20+). No new packages.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  utf8ToBytes,
  leafHashHex,
  merkleRootHex,
  canonicalJson,
} from "./merkle.ts";
import {
  deriveSigningKeys,
  signingKeysFromSeed,
  toB64url,
  fromB64url,
  domainSeparatedSigningBytes,
  type SigningKeys,
} from "./e2ee.ts";

/**
 * The Ed25519 signing-key derivation lives in lib/e2ee.ts (its canonical home:
 * the receipt path signs with the same key), an Ed25519 pair split from the
 * e2ee scrypt seed under a distinct HKDF domain. Re-exported here so exchange
 * callers have one import and both paths derive byte-identical keys.
 */
export { deriveSigningKeys, signingKeysFromSeed };
export type { SigningKeys };

/* -------------------------------------------------------------- constants */

/** Event/leaf format version. Bump only on a breaking leaf-shape change. */
export const EXCHANGE_VERSION = 1 as const;

/**
 * Ed25519 signature domain-separation tags (N-02). The one identity key signs
 * three unrelated contexts: receipt attestations (lib/receipt-attest.ts, its own
 * tag), exchange event leaves, and wire-claim leaves. A distinct tag is framed
 * into the signed bytes of each here, so a signature made for an exchange event
 * can never verify as a wire claim (or as a receipt), regardless of any future
 * schema drift that made two leaf shapes collide.
 */
const EXCHANGE_EVENT_DOMAIN = "databoard/exchange-event/v1";
const WIRE_CLAIM_DOMAIN = "databoard/wire-claim/v1";

/** Domain separator for the DEK commitment. */
const DEK_COMMIT_DOMAIN = "databoard-exchange-dek-v1";
/** Domain separator for the payment-reference commitment. */
const PAYMENT_COMMIT_DOMAIN = "databoard-exchange-pay-v1";
/**
 * WireCreditClaim domain separators (Feature 1, the mutual proof-of-payment
 * that replaces the self-reported pay step). Every one of these is a SALTED
 * SHA-256 the browser computes over a file or bank record the server never
 * receives, so the log holds a commitment, never the underlying document or a
 * bank/account number.
 */
/** Buyer's PAYMENT_SENT_COMMIT: salted hash of (wire confirmation file || amount bucket || N15). */
const WIRE_SENT_COMMIT_DOMAIN = "databoard-wire-sent-v1";
/** Seller's salted commitment to its receiving-bank record. */
const WIRE_RECORD_COMMIT_DOMAIN = "databoard-wire-record-v1";
/** Seller-bound hidden recipient-account nullifier: salted hash of the receiving account. */
const WIRE_ACCOUNT_NULLIFIER_DOMAIN = "databoard-wire-acct-v1";
/** H(IMAD/UETR): salted hash of the wire's rail-unique end-to-end id. */
const WIRE_UETR_COMMIT_DOMAIN = "databoard-wire-uetr-v1";
/** Commitment to the 128-bit wire-reference nonce that derives N15. */
const WIRE_NONCE_COMMIT_DOMAIN = "databoard-wire-nonce-v1";
/** Commitment to a reversal advice (the bank return/recall notice). */
const WIRE_REVERSAL_COMMIT_DOMAIN = "databoard-wire-reversal-v1";
/** Evidence/schema version the WireCreditClaim predicate is pinned to. */
export const WIRE_CLAIM_VERSION = 1 as const;
/** Info label prefixed to every AEAD chunk's AAD, binding it to its session. */
const CHUNK_AAD_PREFIX = "databoard-exchange-v1/chunk/";

/** AES-GCM nonce length. Prepended to each ciphertext chunk. */
const NONCE_BYTES = 12;
/** AES-GCM tag length in bytes (the WebCrypto default). */
const TAG_BYTES = 16;
/** Per-ciphertext-chunk overhead: nonce + GCM tag. */
export const CHUNK_OVERHEAD = NONCE_BYTES + TAG_BYTES;

/** Default plaintext chunk size: caps a stop-after-receiving exposure to one chunk. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** The genesis prevHash: 64 zeros, no predecessor. */
export const GENESIS_PREV_HASH = "0".repeat(64);

/** Demo opaque-ciphertext blob cap (base64 chars). Keeps the demo store small. */
export const MAX_DEMO_BLOB_B64 = 700_000; // ~512 KiB of ciphertext

const HEX64 = /^[0-9a-f]{64}$/;
/** 32-byte Ed25519 public key, base64url, no padding (matches user_e2ee_keys / user_signing_keys). */
const PUBKEY_B64_RE = /^[A-Za-z0-9_-]{43}$/;
/** 64-byte Ed25519 signature, base64url, no padding. */
const SIG_B64_RE = /^[A-Za-z0-9_-]{86}$/;
const SESSION_ID_RE = /^exch_[A-Za-z0-9_-]{6,64}$/;

export type ExchangeRole = "seller" | "buyer";
export type ExchangeState =
  | "committed"
  | "ciphertext_ack"
  | "payment_signaled"
  | "dek_revealed"
  | "completed"
  | "aborted";
export type ExchangeEventType =
  | "commit"
  | "ciphertext_ack"
  | "payment_signaled"
  | "dek_revealed"
  | "completed"
  | "abort";

/**
 * The WireCreditClaim sub-protocol (Feature 1) rides BETWEEN payment_signaled
 * (the buyer's PAYMENT_SENT_COMMIT) and dek_revealed. It is a three-party
 * mutual attestation that a wire carrying this deal's reference was sent and
 * OBSERVED as an inbound credit, and it lives in its own hash-linked chain
 * (exchange_wire_claims) anchored to the payment_signaled event. It is NOT in
 * exchange_events, because that table's type/state CHECK constraints predate
 * this feature and the schema is applied additively (new tables, never altered
 * columns). Each leaf is still an Ed25519-signed SignableLeaf, signed with the
 * same identity key as every other step.
 *
 *   wire_credit_claim        seller signs the canonical claim + a salted
 *                            commitment to its receiving-bank record, after
 *                            observing the inbound credit.
 *   wire_credit_countersign  buyer countersigns that exact claim. This is the
 *                            terminal HONEST state: wire_credit_observed, which
 *                            means "a payment with this reference was sent and
 *                            observed", NOT that a bank irrevocably credited it.
 *   wire_reversed            a later event either party appends when the credit
 *                            is returned / frozen / recalled. It reopens the
 *                            deal and reverts the verified-amount weighting.
 */
export type WireClaimType =
  | "wire_credit_claim"
  | "wire_credit_countersign"
  | "wire_reversed";

/** The derived wire-credit sub-state of a session's payment phase. */
export type WireStatus = "pending" | "claimed" | "observed" | "reversed";

/** The terminal bank statuses the claim is allowed to assert (never "final"). */
export const WIRE_TERMINAL_STATUSES = [
  "credit_observed",
  "credit_posted",
  "credit_accepted",
] as const;
export type WireTerminalStatus = (typeof WIRE_TERMINAL_STATUSES)[number];

/* --------------------------------------------------------------- helpers */

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw as unknown as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesSeal(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await aesKey(keyBytes);
  const ct = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as unknown as BufferSource,
      additionalData: aad as unknown as BufferSource,
    },
    key,
    plaintext as unknown as BufferSource,
  );
  return new Uint8Array(ct);
}

async function aesOpen(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const key = await aesKey(keyBytes);
    const pt = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce as unknown as BufferSource,
        additionalData: aad as unknown as BufferSource,
      },
      key,
      ciphertext as unknown as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/** True for a 64-char lowercase hex digest. */
export function isHash64(s: unknown): s is string {
  return typeof s === "string" && HEX64.test(s);
}

/** True for a well-formed session id (client-chosen, "exch_..."). */
export function isSessionId(s: unknown): s is string {
  return typeof s === "string" && SESSION_ID_RE.test(s);
}

/** A fresh client-chosen session id, bound into the genesis leaf. */
export function newSessionId(): string {
  return `exch_${toB64url(randomBytes(9))}`;
}

/* --------------------------------------------------------- size buckets */

/**
 * A COARSE byte-size bucket, so the server (and the log) learn the order of
 * magnitude of a dataset, never its exact size. Powers-of-two-ish ceilings.
 */
export function sizeBucket(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < 64 * KB) return "<64 KB";
  if (bytes < MB) return "<1 MB";
  if (bytes < 10 * MB) return "<10 MB";
  if (bytes < 100 * MB) return "<100 MB";
  if (bytes < GB) return "<1 GB";
  return ">=1 GB";
}

/* ------------------------------------------------- chunk / AEAD / manifest */

/** A random 32-byte data-encryption key for one deal's dataset. */
export function generateDek(): Uint8Array {
  return randomBytes(32);
}

/**
 * The DEK commitment: SHA-256(domain || dealId || ciphertextRoot || salt || DEK), hex.
 * Binding the ciphertextRoot makes the commitment key-committing over the exact
 * ciphertext, not the key alone: since AES-GCM is not key-committing, a single
 * ciphertext could otherwise be opened under two keys to two valid plaintexts;
 * pinning (ciphertextRoot, DEK) together means the committed ciphertext maps to
 * exactly one revealed key. The commitment is carried in the seller's signed
 * commit leaf and echoed in the signed dek_revealed leaf, so it is bound into
 * the pay/reveal transcript.
 */
export function dekCommitHex(
  dealId: string,
  ciphertextRoot: string,
  salt: Uint8Array,
  dek: Uint8Array,
): string {
  return bytesToHex(
    sha256(
      concat(
        utf8ToBytes(DEK_COMMIT_DOMAIN + "\x1f" + dealId + "\x1f" + ciphertextRoot + "\x1f"),
        salt,
        dek,
      ),
    ),
  );
}

/** A payment-reference commitment: SHA-256(domain || salt || ref), hex. No amount. */
export function paymentCommitHex(salt: Uint8Array, reference: string): string {
  return bytesToHex(
    sha256(concat(utf8ToBytes(PAYMENT_COMMIT_DOMAIN + "\x1f"), salt, utf8ToBytes(reference))),
  );
}

function chunkAad(sessionId: string, index: number): Uint8Array {
  return concat(utf8ToBytes(CHUNK_AAD_PREFIX + sessionId + "/"), u32be(index));
}

/** Split bytes into chunkSize-byte pieces (the last is the remainder). */
function splitPlaintext(data: Uint8Array, chunkSize: number): Uint8Array[] {
  if (data.length === 0) return [new Uint8Array(0)];
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    out.push(data.subarray(i, Math.min(i + chunkSize, data.length)));
  }
  return out;
}

export type EncryptedDataset = {
  /** SHA-256 Merkle root over the plaintext chunk hashes, hex. */
  plaintextRoot: string;
  /** SHA-256 Merkle root over the ciphertext chunk hashes, hex. */
  ciphertextRoot: string;
  /** Number of chunks. */
  chunkCount: number;
  /** Plaintext chunk size used. */
  chunkSize: number;
  /** Coarse size bucket of the plaintext. */
  sizeBucket: string;
  /** The concatenated ciphertext blob: for each chunk, nonce(12) || GCM ct. */
  ciphertext: Uint8Array;
};

/**
 * Seller side: chunk the dataset, AEAD-encrypt each chunk under the DEK with a
 * random per-chunk nonce and a session-bound AAD, and build both Merkle
 * manifests. The returned ciphertext blob is [nonce||ct] per chunk,
 * concatenated, which the buyer can re-split from chunkSize + chunkCount alone.
 * Pure and browser-run: the DEK and plaintext never leave the caller.
 */
export async function encryptDataset(
  sessionId: string,
  data: Uint8Array,
  dek: Uint8Array,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<EncryptedDataset> {
  const plainChunks = splitPlaintext(data, chunkSize);
  const plainLeaves: string[] = [];
  const cipherLeaves: string[] = [];
  const cipherParts: Uint8Array[] = [];
  for (let i = 0; i < plainChunks.length; i++) {
    const pc = plainChunks[i];
    plainLeaves.push(leafHashHex(pc));
    const nonce = randomBytes(NONCE_BYTES);
    const ct = await aesSeal(dek, nonce, pc, chunkAad(sessionId, i));
    const cipherChunk = concat(nonce, ct);
    cipherParts.push(cipherChunk);
    cipherLeaves.push(leafHashHex(cipherChunk));
  }
  return {
    plaintextRoot: merkleRootHex(plainLeaves),
    ciphertextRoot: merkleRootHex(cipherLeaves),
    chunkCount: plainChunks.length,
    chunkSize,
    sizeBucket: sizeBucket(data.length),
    ciphertext: concat(...cipherParts),
  };
}

/**
 * Re-split a concatenated ciphertext blob into its per-chunk pieces using only
 * chunkSize and chunkCount (every full ciphertext chunk is chunkSize +
 * CHUNK_OVERHEAD bytes; the last is whatever remains). Null if the blob length
 * is not consistent with those parameters.
 */
export function splitCiphertext(
  blob: Uint8Array,
  chunkSize: number,
  chunkCount: number,
): Uint8Array[] | null {
  if (chunkCount <= 0) return null;
  const full = chunkSize + CHUNK_OVERHEAD;
  const headLen = (chunkCount - 1) * full;
  const lastLen = blob.length - headLen;
  // The last ciphertext chunk carries at least the AEAD overhead and no more
  // than one full chunk; anything else means the blob does not match the shape.
  if (lastLen < CHUNK_OVERHEAD || lastLen > full) return null;
  const out: Uint8Array[] = [];
  for (let i = 0; i < chunkCount - 1; i++) {
    out.push(blob.subarray(i * full, (i + 1) * full));
  }
  out.push(blob.subarray(headLen));
  return out;
}

/** Buyer side: recompute the ciphertext Merkle root from a received blob. Null on shape error. */
export function ciphertextRootOf(
  blob: Uint8Array,
  chunkSize: number,
  chunkCount: number,
): string | null {
  const parts = splitCiphertext(blob, chunkSize, chunkCount);
  if (!parts) return null;
  return merkleRootHex(parts.map((p) => leafHashHex(p)));
}

export type DecryptResult =
  | { ok: true; plaintext: Uint8Array; plaintextRoot: string }
  | { ok: false; error: "bad_dek" | "shape" | "auth" | "root_mismatch" };

/**
 * Buyer side: verify the DEK against dek_commit, decrypt every ciphertext
 * chunk, and check the plaintext against plaintext_root. Every failure mode is
 * a typed result, never a throw:
 *   bad_dek        the revealed key does not match the committed hash for the
 *                  ciphertext actually held (the commitment binds ciphertextRoot)
 *   shape          the blob does not split into chunkCount pieces
 *   auth           a chunk failed AEAD authentication (wrong key or tampering)
 *   root_mismatch  the chunks decrypt but do not rebuild plaintext_root
 *
 * The dek_commit check recomputes the ciphertext root from the RECEIVED blob and
 * folds it into the commitment, so a revealed key is accepted only for the exact
 * ciphertext it was committed against: a substituted ciphertext (even one that
 * would AEAD-decrypt under some other key) fails bad_dek before any decryption.
 */
export async function decryptAndVerify(args: {
  sessionId: string;
  dealId: string;
  blob: Uint8Array;
  dek: Uint8Array;
  dekSalt: Uint8Array;
  dekCommit: string;
  chunkSize: number;
  chunkCount: number;
  plaintextRoot: string;
}): Promise<DecryptResult> {
  const cipherRoot = ciphertextRootOf(args.blob, args.chunkSize, args.chunkCount);
  if (cipherRoot === null) return { ok: false, error: "shape" };
  if (dekCommitHex(args.dealId, cipherRoot, args.dekSalt, args.dek) !== args.dekCommit) {
    return { ok: false, error: "bad_dek" };
  }
  const parts = splitCiphertext(args.blob, args.chunkSize, args.chunkCount);
  if (!parts) return { ok: false, error: "shape" };
  const plainChunks: Uint8Array[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length < CHUNK_OVERHEAD) return { ok: false, error: "shape" };
    const nonce = part.subarray(0, NONCE_BYTES);
    const ct = part.subarray(NONCE_BYTES);
    const pt = await aesOpen(args.dek, nonce, ct, chunkAad(args.sessionId, i));
    if (pt === null) return { ok: false, error: "auth" };
    plainChunks.push(pt);
  }
  const root = merkleRootHex(plainChunks.map((c) => leafHashHex(c)));
  if (root !== args.plaintextRoot) return { ok: false, error: "root_mismatch" };
  return { ok: true, plaintext: concat(...plainChunks), plaintextRoot: root };
}

/* ---------------------------------------------------- event leaf + chain */

/** The commitment a seller pins at commit time. Every field is a hash or a count. */
export type Commitment = {
  plaintextRoot: string;
  ciphertextRoot: string;
  dekCommit: string;
  /** base64url of the DEK-commit salt, so the buyer can recompute the commitment. */
  dekSalt: string;
  chunkCount: number;
  chunkSize: number;
  sizeBucket: string;
};

/**
 * The signed leaf. `data` carries the step's own commitment fields:
 *   commit            the full Commitment plus the buyer's handle
 *   ciphertext_ack    { ciphertextRoot } the buyer independently recomputed
 *   payment_signaled  { paymentCommit, method }  (a hash and a rail word)
 *   dek_revealed      { dekCommit }  (echo; the DEK itself is never here)
 *   completed         { plaintextRoot }  (echo; the buyer verified it)
 *   abort             { reason }
 */
export type ExchangeLeaf = {
  v: typeof EXCHANGE_VERSION;
  sessionId: string;
  dealId: string;
  seq: number;
  type: ExchangeEventType;
  actorRole: ExchangeRole;
  /** The acting party's handle. */
  actor: string;
  /** eventHash of the previous event, or GENESIS_PREV_HASH for seq 1. */
  prevHash: string;
  /** Client-set timestamp (ms). Metadata; the server records its own too. */
  ts: number;
  /** Step-specific commitment fields. */
  data: Record<string, unknown>;
};

/**
 * The common shape every signed leaf shares: the exchange steps (ExchangeLeaf)
 * and the WireCreditClaim steps (WireClaimLeaf) both satisfy it, so one set of
 * hashing/signing/verifying functions serves both chains. `type` is a bare
 * string here on purpose; each chain validates its own type vocabulary.
 */
export type SignableLeaf = {
  v: typeof EXCHANGE_VERSION;
  sessionId: string;
  dealId: string;
  seq: number;
  type: string;
  actorRole: ExchangeRole;
  actor: string;
  prevHash: string;
  ts: number;
  data: Record<string, unknown>;
};

/** The canonical bytes of a leaf: the exact body that is hashed and framed for signing. */
export function leafBytes(leaf: SignableLeaf): string {
  return canonicalJson(leaf);
}

/** eventHash = SHA-256(canonical leaf bytes), hex. This is what the next event links to. */
export function eventHash(leaf: SignableLeaf): string {
  return bytesToHex(sha256(utf8ToBytes(leafBytes(leaf))));
}

/** The wire-claim leaf types, kept in one place so the signing-tag split is total. */
const WIRE_CLAIM_TYPE_SET: ReadonlySet<string> = new Set<WireClaimType>([
  "wire_credit_claim",
  "wire_credit_countersign",
  "wire_reversed",
]);

/**
 * The signature domain tag for a leaf. Exchange events and wire claims share the
 * SignableLeaf shape and this one signing helper, so the tag is chosen from the
 * (disjoint) type vocabulary: a wire-claim type takes the wire tag, everything
 * else the exchange-event tag. That is what keeps an exchange-event signature
 * from ever verifying as a wire-claim signature (N-02).
 */
function leafSigningTag(leaf: SignableLeaf): string {
  return WIRE_CLAIM_TYPE_SET.has(leaf.type) ? WIRE_CLAIM_DOMAIN : EXCHANGE_EVENT_DOMAIN;
}

/**
 * Sign a leaf with an Ed25519 secret seed. The signed bytes are the
 * domain-separated frame over the canonical leaf bytes, so the signature is
 * scoped to this leaf's context. Returns a base64url signature.
 */
export function signLeaf(leaf: SignableLeaf, secretKey: Uint8Array): string {
  const msg = domainSeparatedSigningBytes(leafSigningTag(leaf), leafBytes(leaf));
  return toB64url(ed25519.sign(msg, secretKey));
}

/** True for a base64url Ed25519 public key (43 chars). */
export function isSigningPubkey(s: unknown): s is string {
  return typeof s === "string" && PUBKEY_B64_RE.test(s);
}

/**
 * Verify a leaf's signature against a base64url Ed25519 public key. Strict
 * Ed25519 (RFC 8032 / { zip215: false }): a malleable/non-canonical signature or
 * a small-order key is refused, so a signed exchange step is non-repudiable and
 * unambiguous. Never throws.
 */
export function verifyLeafSignature(
  leaf: SignableLeaf,
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  try {
    if (!SIG_B64_RE.test(signatureB64) || !PUBKEY_B64_RE.test(publicKeyB64)) return false;
    const sig = fromB64url(signatureB64);
    const pub = fromB64url(publicKeyB64);
    if (!sig || sig.length !== 64 || !pub || pub.length !== 32) return false;
    const msg = domainSeparatedSigningBytes(leafSigningTag(leaf), leafBytes(leaf));
    return ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    return false;
  }
}

/* ---------------------------------------------------- state transitions */

/**
 * The state machine, as data. From a state, which event types are legal and
 * which role may post them, and the state each moves to. This is the single
 * authority the server enforces and the UI reads for "who moves next".
 */
export const TRANSITIONS: Record<
  ExchangeState,
  Partial<Record<ExchangeEventType, { by: ExchangeRole; to: ExchangeState }>>
> = {
  committed: {
    ciphertext_ack: { by: "buyer", to: "ciphertext_ack" },
    abort: { by: "seller", to: "aborted" },
  },
  ciphertext_ack: {
    payment_signaled: { by: "buyer", to: "payment_signaled" },
    abort: { by: "seller", to: "aborted" },
  },
  payment_signaled: {
    dek_revealed: { by: "seller", to: "dek_revealed" },
    abort: { by: "buyer", to: "aborted" },
  },
  dek_revealed: {
    completed: { by: "buyer", to: "completed" },
    abort: { by: "buyer", to: "aborted" },
  },
  completed: {},
  aborted: {},
};

/**
 * Either party may always abort a non-terminal session (the table above only
 * lists the "productive" aborter for the who-moves-next hint). This resolves
 * the actual legality of an abort from whichever role is posting it.
 */
export function isTerminal(state: ExchangeState): boolean {
  return state === "completed" || state === "aborted";
}

export type TransitionCheck =
  | { ok: true; to: ExchangeState }
  | { ok: false; error: "terminal" | "illegal_type" | "wrong_role" };

/**
 * Resolve the transition for an event given the current state and the acting
 * role. An abort by either party is legal from any non-terminal state; every
 * other event must match the transition table's role exactly.
 */
export function resolveTransition(
  state: ExchangeState,
  type: ExchangeEventType,
  role: ExchangeRole,
): TransitionCheck {
  if (isTerminal(state)) return { ok: false, error: "terminal" };
  if (type === "abort") return { ok: true, to: "aborted" };
  const t = TRANSITIONS[state][type];
  if (!t) return { ok: false, error: "illegal_type" };
  if (t.by !== role) return { ok: false, error: "wrong_role" };
  return { ok: true, to: t.to };
}

/** Whose move it is next, and what they would be doing, for the UI header. */
export function whoMovesNext(
  state: ExchangeState,
): { role: ExchangeRole; type: ExchangeEventType } | null {
  switch (state) {
    case "committed":
      return { role: "buyer", type: "ciphertext_ack" };
    case "ciphertext_ack":
      return { role: "buyer", type: "payment_signaled" };
    case "payment_signaled":
      return { role: "seller", type: "dek_revealed" };
    case "dek_revealed":
      return { role: "buyer", type: "completed" };
    default:
      return null;
  }
}

/* ---------------------------------------------------- shape validation */

/** Validate the data block of a leaf for its type. Pure, used by the server. */
export function isValidLeafData(type: ExchangeEventType, data: unknown): boolean {
  if (data === null || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  switch (type) {
    case "commit":
      return (
        isHash64(d.plaintextRoot) &&
        isHash64(d.ciphertextRoot) &&
        isHash64(d.dekCommit) &&
        typeof d.dekSalt === "string" &&
        d.dekSalt.length > 0 &&
        Number.isInteger(d.chunkCount) &&
        (d.chunkCount as number) > 0 &&
        Number.isInteger(d.chunkSize) &&
        (d.chunkSize as number) > 0 &&
        typeof d.sizeBucket === "string" &&
        typeof d.buyer === "string" &&
        (d.buyer as string).length > 0
      );
    case "ciphertext_ack":
      return isHash64(d.ciphertextRoot);
    case "payment_signaled":
      return isHash64(d.paymentCommit) && typeof d.method === "string";
    case "dek_revealed":
      return isHash64(d.dekCommit);
    case "completed":
      return isHash64(d.plaintextRoot);
    case "abort":
      return typeof d.reason === "string";
  }
}

/** A stored event, as the read API returns it and verifyChain consumes it. */
export type StoredEvent = {
  seq: number;
  type: ExchangeEventType;
  actorRole: ExchangeRole;
  actor: string;
  prevHash: string;
  ts: number;
  data: Record<string, unknown>;
  eventHash: string;
  signerPubkey: string;
  signature: string;
};

/** Rebuild the signed leaf from a stored event (the exact object that was signed). */
export function leafOf(sessionId: string, dealId: string, e: StoredEvent): ExchangeLeaf {
  return {
    v: EXCHANGE_VERSION,
    sessionId,
    dealId,
    seq: e.seq,
    type: e.type,
    actorRole: e.actorRole,
    actor: e.actor,
    prevHash: e.prevHash,
    ts: e.ts,
    data: e.data,
  };
}

export type ChainCheck = { ok: true } | { ok: false; error: string; seq: number };

/**
 * Verify a full event chain, the way a client or an auditor re-checks a
 * session it fetched: contiguous seqs from 1, each prevHash links to the prior
 * eventHash, each stored eventHash matches the recomputed leaf, each signature
 * verifies against its stated pubkey, and each state transition is legal. Does
 * NOT check pubkey ownership (that a pubkey is the actor's registered key):
 * the server does that at append time against user_signing_keys; a public
 * re-verifier checks the math and the linkage.
 */
export function verifyChain(
  sessionId: string,
  dealId: string,
  events: StoredEvent[],
): ChainCheck {
  let state: ExchangeState | null = null;
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1) return { ok: false, error: "seq_gap", seq: e.seq };
    if (i === 0 && e.type !== "commit") return { ok: false, error: "genesis_not_commit", seq: e.seq };
    if (e.prevHash !== prev) return { ok: false, error: "prev_hash_mismatch", seq: e.seq };
    if (!isValidLeafData(e.type, e.data)) return { ok: false, error: "bad_data", seq: e.seq };
    const leaf = leafOf(sessionId, dealId, e);
    if (eventHash(leaf) !== e.eventHash) return { ok: false, error: "event_hash_mismatch", seq: e.seq };
    if (!verifyLeafSignature(leaf, e.signature, e.signerPubkey)) {
      return { ok: false, error: "bad_signature", seq: e.seq };
    }
    if (i === 0) {
      if (e.type !== "commit" || e.actorRole !== "seller") {
        return { ok: false, error: "bad_genesis", seq: e.seq };
      }
      state = "committed";
    } else {
      if (state === null) return { ok: false, error: "no_state", seq: e.seq };
      const t = resolveTransition(state, e.type, e.actorRole);
      if (!t.ok) return { ok: false, error: `illegal_transition:${t.error}`, seq: e.seq };
      state = t.to;
    }
    prev = e.eventHash;
  }
  return { ok: true };
}

/* ============================================================ WireCreditClaim
 *
 * Feature 1: the mutual proof-of-payment that upgrades the exchange's pay step
 * from a self-reported signal to a three-party attestation. See the WireClaimType
 * comment above for the state machine and the honesty bound (wire_credit_observed
 * is NOT fiat_final). Everything below is isomorphic: it runs in the browser to
 * build and sign the leaves, and on the server to re-verify them.
 */

/* --------------------------------------------------- wire-reference nonce */

/** Crockford Base32 alphabet: excludes I, L, O, U so a reference is transcription-safe. */
const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode bytes as uppercase Crockford Base32, no padding. 32-bit safe. */
export function crockford32(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = ((value & 0x1f) << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD32[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh 128-bit wire-reference nonce, kept on the seller's device. */
export function wireNonce(): Uint8Array {
  return randomBytes(16);
}

/**
 * N15: the rail-safe alias the buyer puts in the wire. First 15 Crockford-Base32
 * chars of SHA-256(dealId || nonce), UPPERCASE ASCII, no spaces. Short enough for
 * a Fedwire/CHIPS/SWIFT EndToEndId (~35) and an ACH id (15), and opaque, so the
 * bank memo carries a reference, not the deal.
 */
export function n15Of(dealId: string, nonce: Uint8Array): string {
  return crockford32(sha256(concat(utf8ToBytes(dealId), nonce))).slice(0, 15);
}

/** True for a well-formed N15: 15 uppercase Crockford-Base32 chars. */
const N15_RE = /^[0-9A-HJKMNP-TV-Z]{15}$/;
export function isN15(s: unknown): s is string {
  return typeof s === "string" && N15_RE.test(s);
}

/** Commitment to the wire nonce: SHA-256(domain || dealId || salt || nonce), hex. */
export function wireNonceCommitHex(dealId: string, salt: Uint8Array, nonce: Uint8Array): string {
  return bytesToHex(
    sha256(concat(utf8ToBytes(WIRE_NONCE_COMMIT_DOMAIN + "\x1f" + dealId + "\x1f"), salt, nonce)),
  );
}

/* --------------------------------------------------- wire commitments */

/**
 * The buyer's PAYMENT_SENT_COMMIT: SHA-256(domain || salt || amountBucket || N15
 * || wire confirmation file bytes). The file (a wire receipt PDF/image) is hashed
 * in the browser and NEVER uploaded; the salt keeps the commitment from being a
 * dictionary of receipts. Binds the sent proof to this exact reference and bucket.
 */
export function wireSentCommitHex(
  salt: Uint8Array,
  amountBucket: string,
  n15: string,
  fileBytes: Uint8Array,
): string {
  return bytesToHex(
    sha256(
      concat(
        utf8ToBytes(WIRE_SENT_COMMIT_DOMAIN + "\x1f" + amountBucket + "\x1f" + n15 + "\x1f"),
        salt,
        fileBytes,
      ),
    ),
  );
}

/** Seller's salted commitment to its receiving-bank record (the credit advice bytes). */
export function wireRecordCommitHex(salt: Uint8Array, recordBytes: Uint8Array): string {
  return bytesToHex(
    sha256(concat(utf8ToBytes(WIRE_RECORD_COMMIT_DOMAIN + "\x1f"), salt, recordBytes)),
  );
}

/**
 * The seller-bound hidden recipient-account nullifier: SHA-256(domain || sellerHandle
 * || account). Deterministic per (seller, account) so the SAME receiving account is
 * linkable across a seller's deals (a soft anti-sybil signal) without ever revealing
 * the account number. No random salt on purpose: the linkability IS the point.
 */
export function accountNullifierHex(sellerHandle: string, account: string): string {
  return bytesToHex(
    sha256(utf8ToBytes(WIRE_ACCOUNT_NULLIFIER_DOMAIN + "\x1f" + sellerHandle + "\x1f" + account)),
  );
}

/** H(IMAD/UETR): salted hash of the wire's rail-unique end-to-end id. Never the raw id. */
export function uetrCommitHex(salt: Uint8Array, uetr: string): string {
  return bytesToHex(
    sha256(concat(utf8ToBytes(WIRE_UETR_COMMIT_DOMAIN + "\x1f"), salt, utf8ToBytes(uetr))),
  );
}

/** Salted commitment to a reversal advice (bank return/recall notice bytes). */
export function wireReversalCommitHex(salt: Uint8Array, adviceBytes: Uint8Array): string {
  return bytesToHex(
    sha256(concat(utf8ToBytes(WIRE_REVERSAL_COMMIT_DOMAIN + "\x1f"), salt, adviceBytes)),
  );
}

/* --------------------------------------------------- wire leaf + chain */

/** A signed WireCreditClaim leaf: structurally a SignableLeaf with a WireClaimType. */
export type WireClaimLeaf = SignableLeaf & { type: WireClaimType };

/** A stored wire-claim event, as the read API returns it and verifyWireChain consumes it. */
export type StoredWireEvent = {
  seq: number;
  type: WireClaimType;
  actorRole: ExchangeRole;
  actor: string;
  prevHash: string;
  ts: number;
  data: Record<string, unknown>;
  eventHash: string;
  signerPubkey: string;
  signature: string;
};

const MAX_WIRE_REASON = 200;

/**
 * The required predicate for each wire step. The server and the browser both
 * enforce it; a step whose data omits a bound field is refused, so a claim
 * cannot silently drop the amount, the reference, or the account nullifier.
 */
export function isValidWireData(type: WireClaimType, data: unknown): boolean {
  if (data === null || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  switch (type) {
    case "wire_credit_claim":
      // The canonical WireCreditClaim: deal reference + WIRE + CREDIT + amount
      // bucket + terminal bank status + value time + account nullifier +
      // H(IMAD/UETR) + salted bank-record commitment + schema version.
      return (
        isN15(d.n15) &&
        typeof d.rail === "string" &&
        (d.rail as string).length > 0 &&
        typeof d.amountBucket === "string" &&
        (d.amountBucket as string).length > 0 &&
        typeof d.terminalStatus === "string" &&
        (WIRE_TERMINAL_STATUSES as readonly string[]).includes(d.terminalStatus as string) &&
        Number.isInteger(d.valueTime) &&
        (d.valueTime as number) > 0 &&
        isHash64(d.bankRecordCommit) &&
        isHash64(d.accountNullifier) &&
        isHash64(d.uetrCommit) &&
        d.schemaVersion === WIRE_CLAIM_VERSION
      );
    case "wire_credit_countersign":
      return isHash64(d.claimHash) && isN15(d.n15) && d.accept === true;
    case "wire_reversed":
      return (
        isHash64(d.claimHash) &&
        typeof d.reason === "string" &&
        (d.reason as string).length > 0 &&
        (d.reason as string).length <= MAX_WIRE_REASON &&
        (d.reversalCommit === undefined || isHash64(d.reversalCommit))
      );
  }
}

export type WireTransitionCheck =
  | { ok: true; to: WireStatus }
  | { ok: false; error: "illegal_type" | "wrong_role" | "bad_state" };

/**
 * The wire sub-state machine. It starts at "pending" the moment the buyer's
 * payment_signaled lands, and:
 *   pending  --wire_credit_claim(seller)-->        claimed
 *   claimed  --wire_credit_countersign(buyer)-->   observed
 *   observed --wire_reversed(either)-->            reversed
 *   reversed --wire_credit_claim(seller)-->        claimed   (a re-attempt)
 * A reversal is legal from observed only: there is nothing to reverse before a
 * credit was mutually observed.
 */
export function resolveWireTransition(
  status: WireStatus,
  type: WireClaimType,
  role: ExchangeRole,
): WireTransitionCheck {
  switch (type) {
    case "wire_credit_claim":
      if (status !== "pending" && status !== "reversed") return { ok: false, error: "bad_state" };
      if (role !== "seller") return { ok: false, error: "wrong_role" };
      return { ok: true, to: "claimed" };
    case "wire_credit_countersign":
      if (status !== "claimed") return { ok: false, error: "bad_state" };
      if (role !== "buyer") return { ok: false, error: "wrong_role" };
      return { ok: true, to: "observed" };
    case "wire_reversed":
      if (status !== "observed") return { ok: false, error: "bad_state" };
      return { ok: true, to: "reversed" };
  }
}

/** The wire sub-state a chain of wire events implies. Empty chain = pending. */
export function wireStatusFrom(events: readonly { type: WireClaimType }[]): WireStatus {
  let status: WireStatus = "pending";
  for (const e of events) {
    const t = resolveWireTransition(status, e.type, e.type === "wire_credit_claim" ? "seller" : "buyer");
    if (t.ok) status = t.to;
  }
  return status;
}

/** Rebuild a wire leaf from a stored wire event (the exact object that was signed). */
export function wireLeafOf(sessionId: string, dealId: string, e: StoredWireEvent): WireClaimLeaf {
  return {
    v: EXCHANGE_VERSION,
    sessionId,
    dealId,
    seq: e.seq,
    type: e.type,
    actorRole: e.actorRole,
    actor: e.actor,
    prevHash: e.prevHash,
    ts: e.ts,
    data: e.data,
  };
}

/**
 * Verify a wire-claim chain the way a client or auditor re-checks it: contiguous
 * seqs from 1, the first event anchored to the payment_signaled event's hash
 * (so the wire chain is cryptographically bound to the exchange chain it hangs
 * off), each prevHash linking to the prior eventHash, each stored eventHash
 * matching the recomputed leaf, each signature verifying, each transition legal,
 * and each countersign/reversal naming the exact claim it acts on. Does not check
 * pubkey ownership (the server does that at append time).
 */
export function verifyWireChain(
  sessionId: string,
  dealId: string,
  anchorHash: string,
  events: StoredWireEvent[],
): ChainCheck {
  let status: WireStatus = "pending";
  let prev = anchorHash;
  let lastClaimHash: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i + 1) return { ok: false, error: "seq_gap", seq: e.seq };
    if (e.prevHash !== prev) return { ok: false, error: "prev_hash_mismatch", seq: e.seq };
    if (!isValidWireData(e.type, e.data)) return { ok: false, error: "bad_data", seq: e.seq };
    const leaf = wireLeafOf(sessionId, dealId, e);
    if (eventHash(leaf) !== e.eventHash) return { ok: false, error: "event_hash_mismatch", seq: e.seq };
    if (!verifyLeafSignature(leaf, e.signature, e.signerPubkey)) {
      return { ok: false, error: "bad_signature", seq: e.seq };
    }
    const t = resolveWireTransition(status, e.type, e.actorRole);
    if (!t.ok) return { ok: false, error: `illegal_transition:${t.error}`, seq: e.seq };
    if (e.type === "wire_credit_claim") lastClaimHash = e.eventHash;
    else if (e.data.claimHash !== lastClaimHash) {
      return { ok: false, error: "claim_hash_mismatch", seq: e.seq };
    }
    status = t.to;
    prev = e.eventHash;
  }
  return { ok: true };
}
