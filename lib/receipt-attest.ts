/**
 * lib/receipt-attest.ts
 *
 * The party-signature layer of a deal receipt, as ONE isomorphic module. It
 * runs unchanged in the browser (the deal page's sign button and the public
 * /receipts/verify checker) and on the server (lib/party-sigs.ts assembling
 * the receipt, lib/receipts.ts validating its shape). Nothing here touches the
 * database or node:crypto, so a client bundle can import it freely.
 *
 * WHAT IT ADDS to a receipt. The base receipt (lib/receipts.ts) is signed with
 * a shared-secret MAC the platform holds, so the platform can forge it. This
 * layer adds a signature from EACH confirmed participant, made with their own
 * Ed25519 key (user_signing_keys), over the canonical receipt bytes:
 *
 *   base   = canonicalJson({ v, dealId, tier, buyerToken, amountBucket,
 *              buyerIsOther, schemaSha256, commit, attestedAt, seq,
 *              participants, signers })
 *   signed = domainSeparatedSigningBytes("databoard/receipt-attest/v1", base)
 *
 * where `participants` is the FULL sorted roster of confirmed handles on the
 * deal and `signers` is the subset of them that hold a registered signing key,
 * each { handle, pubkey }, sorted by handle. The base commits EVERY field the
 * receipt asserts, so a party's signature fixes the buyer-off-list bit, the
 * schema/commit context, WHO ELSE is on the receipt (both the full roster and
 * the signing subset), and WHICH receipt state: drop, swap, or flip any covered
 * field and every remaining signature stops verifying (N-04). `seq` is the
 * receipt_minted transparency-log sequence, so a signature is scoped to the
 * exact receipt state (a tier change mints a new leaf, a new seq, and asks the
 * parties to re-sign). The signed bytes carry a domain-separation frame so a
 * receipt signature can never be lifted into the exchange or wire context
 * (N-02), and verification is strict Ed25519 ({ zip215: false }).
 *
 * The residual, stated honestly on /transparency: the roster's pubkeys come
 * from an operator-served key directory (/api/signing/pubkey), so this is
 * trust-on-first-use, not key transparency. Anyone can still confirm a
 * signature verifies against the pubkey the receipt carries, and that the
 * pubkey matches the one the directory serves for that handle; a fully
 * independent binding (witness-cosigned key transparency) is future work.
 *
 * Working currency is base64url for pubkeys (43 chars, a 32-byte key) and
 * signatures (86 chars, a 64-byte sig), the same convention as the e2ee keys
 * and lib/exchange.ts's signing keys.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalJson } from "./merkle.ts";
import { toB64url, fromB64url, domainSeparatedSigningBytes } from "./e2ee.ts";

/**
 * Party-signature format version. Bump on a breaking base-shape change. v2:
 * the base now covers EVERY receipt field the parties attest (buyerIsOther,
 * schemaSha256, commit, and the FULL confirmed-participant roster, not only the
 * subset holding a signing key), and the signed bytes are wrapped in a
 * domain-separation frame (N-02, N-04). A v1 signature cannot verify as v2.
 */
export const PARTY_SIG_VERSION = 2 as const;

/**
 * Domain-separation tag for a receipt party attestation. Distinct from the
 * exchange-event and wire-claim tags in lib/exchange.ts, so one identity key's
 * signature over a receipt can never verify as an exchange or wire signature.
 */
const RECEIPT_ATTEST_DOMAIN = "databoard/receipt-attest/v1";

const PUBKEY_B64_RE = /^[A-Za-z0-9_-]{43}$/; // 32-byte Ed25519 key, base64url
const SIG_B64_RE = /^[A-Za-z0-9_-]{86}$/; // 64-byte Ed25519 signature, base64url
/** A handle: the same shape the board assigns and validates elsewhere. */
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;

/** One confirmed participant and the signing key their password derives. */
export type ReceiptSigner = { handle: string; pubkey: string };
/** One collected party signature, referencing a signer by handle. */
export type ReceiptPartySig = { handle: string; sig: string };
/** The attestation block folded into a receipt: the roster and the sigs so far. */
export type ReceiptAttestation = { signers: ReceiptSigner[]; sigs: ReceiptPartySig[] };

/** The fields the party signing base is built from: every field the receipt asserts. */
export type PartyBaseFields = {
  dealId: string;
  tier: string;
  buyerToken: string;
  amountBucket: string;
  /** Whether the buyer was typed off-list. Covered so the operator cannot flip it. */
  buyerIsOther: boolean;
  /** SHA-256 of the schema the platform ran at mint. Covered as signed context. */
  schemaSha256: string;
  /** Deploy commit at mint, or null. Covered as signed context. */
  commit: string | null;
  attestedAt: number;
  /** The receipt_minted transparency-log sequence this receipt is bound to. */
  seq: number;
  /** Every confirmed handle on the deal, sorted. The full roster, not just signers. */
  participants: string[];
  /** The subset of participants holding a registered signing key, sorted by handle. */
  signers: ReceiptSigner[];
};

/** Roster in canonical order: sorted by handle, each reduced to {handle, pubkey}. */
export function sortSigners(signers: ReceiptSigner[]): ReceiptSigner[] {
  return [...signers]
    .map((s) => ({ handle: s.handle, pubkey: s.pubkey }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}

/**
 * The exact bytes every party signs. Deterministic: canonical JSON with the
 * roster pre-sorted, so the same receipt state always yields identical bytes on
 * the browser and the server.
 */
export function partySigningBase(f: PartyBaseFields): string {
  return canonicalJson({
    v: PARTY_SIG_VERSION,
    dealId: f.dealId,
    tier: f.tier,
    buyerToken: f.buyerToken,
    amountBucket: f.amountBucket,
    buyerIsOther: f.buyerIsOther,
    schemaSha256: f.schemaSha256,
    commit: f.commit,
    attestedAt: f.attestedAt,
    seq: f.seq,
    participants: [...f.participants].sort((a, b) => a.localeCompare(b)),
    signers: sortSigners(f.signers),
  });
}

/**
 * Ed25519-sign the party base with a raw 32-byte seed. The signed bytes are the
 * domain-separated frame over the canonical base, so this signature is scoped to
 * the receipt-attestation context. Returns a base64url signature.
 */
export function signReceiptBase(base: string, secretKey: Uint8Array): string {
  const msg = domainSeparatedSigningBytes(RECEIPT_ATTEST_DOMAIN, base);
  return toB64url(ed25519.sign(msg, secretKey));
}

/**
 * Verify one party signature over the base against a base64url pubkey. Strict
 * Ed25519 (RFC 8032 / { zip215: false }): a non-canonical signature, an
 * out-of-range S, or a small-order key is refused, giving SBS non-repudiation.
 * Never throws.
 */
export function verifyPartySig(base: string, pubkeyB64: string, sigB64: string): boolean {
  const pub = fromB64url(pubkeyB64);
  const sig = fromB64url(sigB64);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const msg = domainSeparatedSigningBytes(RECEIPT_ATTEST_DOMAIN, base);
    return ed25519.verify(sig, msg, pub, { zip215: false });
  } catch {
    return false;
  }
}

/** True when a value is a well-formed roster (array of {handle, pubkey hex}). */
export function isSignerArray(v: unknown): v is ReceiptSigner[] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        s != null &&
        typeof s === "object" &&
        typeof (s as ReceiptSigner).handle === "string" &&
        typeof (s as ReceiptSigner).pubkey === "string",
    )
  );
}

/** True when a value is a well-formed attestation block ({signers, sigs}). */
export function isAttestation(v: unknown): v is ReceiptAttestation {
  if (v == null || typeof v !== "object") return false;
  const a = v as ReceiptAttestation;
  return (
    isSignerArray(a.signers) &&
    Array.isArray(a.sigs) &&
    a.sigs.every(
      (s) =>
        s != null &&
        typeof s === "object" &&
        typeof (s as ReceiptPartySig).handle === "string" &&
        typeof (s as ReceiptPartySig).sig === "string",
    )
  );
}

export type PartyVerification = {
  /** The roster the receipt commits to. */
  signers: ReceiptSigner[];
  /** Handles whose signature verified, sorted. */
  valid: string[];
  /** Handles present in `sigs` whose signature did NOT verify, sorted. */
  invalid: string[];
  /** True when every roster member has a valid signature (and the roster is non-empty). */
  allSigned: boolean;
};

/**
 * Verify the collected party signatures against the roster and the receipt
 * fields, the way the browser and the verify API both do it. A signature counts
 * as valid only when its handle is in the roster AND it verifies against that
 * roster member's pubkey over the recomputed base. Signatures from a handle not
 * on the roster, or over stale bytes, land in `invalid`. Malformed or hostile
 * pubkeys/sigs are rejected, never thrown.
 */
export function verifyAttestation(
  fields: PartyBaseFields,
  sigs: ReceiptPartySig[],
): PartyVerification {
  const base = partySigningBase(fields);
  const pubByHandle = new Map(fields.signers.map((s) => [s.handle, s.pubkey]));
  const valid = new Set<string>();
  const invalid = new Set<string>();
  for (const { handle, sig } of sigs) {
    const pub = pubByHandle.get(handle);
    if (pub && !valid.has(handle) && verifyPartySig(base, pub, sig)) {
      valid.add(handle);
    } else {
      invalid.add(handle);
    }
  }
  const allSigned =
    fields.signers.length > 0 && fields.signers.every((s) => valid.has(s.handle));
  return {
    signers: fields.signers,
    valid: [...valid].sort(),
    invalid: [...invalid].filter((h) => !valid.has(h)).sort(),
    allSigned,
  };
}

/** True for a base64url Ed25519 public key. Exported for the registration endpoint. */
export function isPubkey(v: unknown): v is string {
  return typeof v === "string" && PUBKEY_B64_RE.test(v);
}

/** True for a base64url Ed25519 signature. */
export function isSig(v: unknown): v is string {
  return typeof v === "string" && SIG_B64_RE.test(v);
}

/** True for a well-formed handle. */
export function isHandle(v: unknown): v is string {
  return typeof v === "string" && HANDLE_RE.test(v);
}
