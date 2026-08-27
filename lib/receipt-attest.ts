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
 *   partySigningBase = canonicalJson({ v, dealId, tier, buyerToken,
 *                        amountBucket, attestedAt, seq, signers })
 *
 * where `signers` is the full roster of confirmed participants who hold a
 * registered signing key, each { handle, pubkey }, sorted by handle. Because
 * the base commits to the whole roster, a party's signature also fixes WHO
 * ELSE is on the receipt: drop or swap a signer and every remaining signature
 * stops verifying. `seq` is the receipt_minted transparency-log sequence, so a
 * signature is scoped to the exact receipt state (a tier change mints a new
 * leaf, a new seq, and asks the parties to re-sign).
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
import { utf8ToBytes, canonicalJson } from "./merkle.ts";
import { toB64url, fromB64url } from "./e2ee.ts";

/** Party-signature format version. Bump only on a breaking base-shape change. */
export const PARTY_SIG_VERSION = 1 as const;

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

/** The fields the party signing base is built from. */
export type PartyBaseFields = {
  dealId: string;
  tier: string;
  buyerToken: string;
  amountBucket: string;
  attestedAt: number;
  /** The receipt_minted transparency-log sequence this receipt is bound to. */
  seq: number;
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
    attestedAt: f.attestedAt,
    seq: f.seq,
    signers: sortSigners(f.signers),
  });
}

/** Ed25519-sign the party base with a raw 32-byte seed. Returns a base64url signature. */
export function signReceiptBase(base: string, secretKey: Uint8Array): string {
  return toB64url(ed25519.sign(utf8ToBytes(base), secretKey));
}

/** Verify one party signature over the base against a base64url pubkey. Never throws. */
export function verifyPartySig(base: string, pubkeyB64: string, sigB64: string): boolean {
  const pub = fromB64url(pubkeyB64);
  const sig = fromB64url(sigB64);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, utf8ToBytes(base), pub);
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
