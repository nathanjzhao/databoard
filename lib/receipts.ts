/**
 * lib/receipts.ts
 *
 * Portable, platform-signed deal receipts. Server-only, pure: no database
 * access, no PII, no message content, no buyer de-blinding. A receipt is the
 * off-platform track-record artifact that makes recording a deal on the board
 * worth more than the referral fee it costs. It binds, in one compact token:
 *
 *   deal id, tier, every confirmed participant handle, the already-blinded
 *   buyer token, the amount rounded to a $10k BUCKET (never the exact figure),
 *   when the deal became co-attested, and the schema/commit the platform ran
 *   when it signed.
 *
 * ONLY an attested deal (co-attested or evidence-committed) mints a receipt. A
 * solo or still-claimed deal mints nothing: a unilateral claim is worth zero
 * here, exactly as it is worth zero for reputation and for fees.
 *
 * SIGNING, stated honestly (and again on /transparency/verification):
 * sig = HMAC(SERVER_PEPPER, "receipt" | canonical-json(payload)). This is a
 * shared-secret MAC, not a public-key signature. The platform holds the key,
 * so the platform can forge its own receipts. A verifying receipt therefore
 * proves "DataBoard vouches that this deal was recorded here", not a
 * third-party-unforgeable fact. That is the same operator-attested trust tier
 * as the rest of the surface; the real upgrade is the TEE endgame noted
 * elsewhere. A receipt also verifies only against the pepper that minted it,
 * so a dev-pepper receipt is genuine only on that dev instance.
 *
 * The token is a deterministic function of deal state: the same attested deal
 * always mints byte-identical bytes, so it is idempotent and testable. When a
 * deal climbs from co-attested to evidence-committed the tier and attestation
 * timestamp change, so the token changes with it.
 */

import { hmacHex, safeEqual, sha256Hex } from "./crypto.ts";
import { readSchemaSql } from "./db.ts";
import { usdRounded10k } from "../components/deals/format.ts";
import type { DealDetail, DealTier } from "./deals.ts";

/* -------------------------------------------------------------- constants */

/** Receipt format version. Bump only on a breaking payload change. */
export const RECEIPT_VERSION = 1 as const;

/** Token wire prefix, so a receipt is recognizable on sight and by regex. */
export const RECEIPT_PREFIX = "rcpt_v1";

/** Domain separator for the receipt MAC, keeping it clear of every other HMAC use. */
const RECEIPT_HMAC_DOMAIN = "receipt";

/** Only these tiers mint. "claimed" (solo or unconfirmed) mints nothing. */
export type ReceiptTier = "co_attested" | "evidence_committed";

/* ------------------------------------------------------------------ types */

/**
 * The append-only-log coordinates of a receipt: the sequence number and RFC
 * 6962 leaf hash of the receipt_minted leaf. Present when the receipt was
 * minted through the log-aware path (lib/translog.ts), absent otherwise. When
 * present, a verifier can go on to fetch an inclusion proof and confirm the
 * receipt sits in the public log at a signed tree size, not merely that the
 * operator's MAC is intact.
 */
export type ReceiptLog = { seq: number; leafHash: string };

/** The signed body of a receipt. Everything here is metadata; nothing is PII. */
export type ReceiptPayload = {
  /** Format version. */
  v: typeof RECEIPT_VERSION;
  /** The deal this receipt is about. */
  dealId: string;
  /** Attestation tier at mint time. Never "claimed": claimed deals do not mint. */
  tier: ReceiptTier;
  /** Every confirmed handle on the deal (reporter + confirmed participants), sorted. */
  participants: string[];
  /** The already-blinded buyer token. Not invertible without the server OPRF key. */
  buyerToken: string;
  /** Whether the buyer was typed off-list, the same honesty bit the board carries. */
  buyerIsOther: boolean;
  /** Total rounded to the nearest $10k bucket ("$90k", "$1.5M", "<$10k"). Never exact. */
  amountBucket: string;
  /** When the deal became co-attested: the latest confirmation timestamp. */
  attestedAt: number;
  /** SHA-256 of db/schema.sql the platform ran when it signed. Context, not a promise. */
  schemaSha256: string;
  /** Deploy commit the platform ran when it signed, or null off Vercel. Context. */
  commit: string | null;
  /**
   * Append-only-log coordinates, when this receipt was minted through the
   * log-aware path. Optional and additive: a receipt with no `log` is exactly
   * the token this module always produced, and it still verifies. When
   * present, the signature covers it like every other field.
   */
  log?: ReceiptLog;
};

export type VerifyReceiptResult =
  | { ok: true; receipt: ReceiptPayload }
  | { ok: false; error: "malformed" | "unsupported_version" | "bad_signature" };

/* --------------------------------------------------------- canonical json */

/**
 * Deterministic JSON: object keys sorted, arrays left in the order the caller
 * chose (participants are pre-sorted before they reach here). Two payloads that
 * are equal as values serialize to identical bytes, so the MAC is stable no
 * matter how the object was built or how a client re-encoded the token.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/* -------------------------------------------------------------- signing */

function sign(payload: ReceiptPayload): string {
  return hmacHex(RECEIPT_HMAC_DOMAIN, canonicalJson(payload));
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function fromBase64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** Assemble the wire token: "rcpt_v1.<base64url(canonical)>.<sigHex>". */
export function encodeReceipt(payload: ReceiptPayload): string {
  const canonical = canonicalJson(payload);
  const sig = hmacHex(RECEIPT_HMAC_DOMAIN, canonical);
  return `${RECEIPT_PREFIX}.${base64url(canonical)}.${sig}`;
}

/* ---------------------------------------------------------------- context */

/**
 * The schema/commit the platform runs right now. Bound into every receipt so a
 * later reader can see which build vouched for it. The schema hash is cheap and
 * pure; the commit is present only on a Vercel deploy.
 */
export function receiptContext(): { schemaSha256: string; commit: string | null } {
  return {
    schemaSha256: sha256Hex(readSchemaSql()),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };
}

/* ----------------------------------------------------------------- mint */

function isReceiptTier(tier: DealTier): tier is ReceiptTier {
  return tier === "co_attested" || tier === "evidence_committed";
}

/**
 * Mint a receipt token for a deal, or null when the deal is not attested. A
 * claimed-tier deal (solo, or nobody has co-signed) returns null on purpose:
 * there is no artifact to hand out for a unilateral claim.
 *
 * The caller must already have authorized the viewer for this deal (the deal
 * page only reaches this for a participant); minting reads nothing the viewer
 * could not already see on the deal page.
 */
export function mintReceiptForDeal(deal: DealDetail): string | null {
  const payload = receiptPayloadForDeal(deal);
  return payload ? encodeReceipt(payload) : null;
}

/** The unsigned payload for a deal, or null when the deal does not mint. */
export function receiptPayloadForDeal(deal: DealDetail): ReceiptPayload | null {
  if (!isReceiptTier(deal.tier)) return null;

  // Confirmed handles only: reporter (always confirmed) plus every confirmed
  // participant. Declined and pending rows are not part of what the deal proves.
  const confirmed = deal.split.filter((r) => r.status === "confirmed");
  const participants = [...new Set(confirmed.map((r) => r.username))].sort((a, b) =>
    a.localeCompare(b),
  );
  const attestedAt = confirmed.reduce(
    (max, r) => (r.confirmedAt != null && r.confirmedAt > max ? r.confirmedAt : max),
    0,
  );

  const { schemaSha256, commit } = receiptContext();
  return {
    v: RECEIPT_VERSION,
    dealId: deal.id,
    tier: deal.tier,
    participants,
    buyerToken: deal.buyerToken,
    buyerIsOther: deal.buyerIsOther,
    amountBucket: usdRounded10k(deal.totalUsd),
    attestedAt,
    schemaSha256,
    commit,
  };
}

/* --------------------------------------------------------------- verify */

function isValidPayloadShape(v: unknown): v is ReceiptPayload {
  if (v === null || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.v === "number" &&
    typeof p.dealId === "string" &&
    (p.tier === "co_attested" || p.tier === "evidence_committed") &&
    Array.isArray(p.participants) &&
    p.participants.every((x) => typeof x === "string") &&
    typeof p.buyerToken === "string" &&
    typeof p.buyerIsOther === "boolean" &&
    typeof p.amountBucket === "string" &&
    typeof p.attestedAt === "number" &&
    typeof p.schemaSha256 === "string" &&
    (p.commit === null || typeof p.commit === "string") &&
    isValidLogShape(p.log)
  );
}

/** The optional log binding: absent, or { seq:number, leafHash:string }. */
function isValidLogShape(log: unknown): boolean {
  if (log === undefined) return true;
  if (log === null || typeof log !== "object") return false;
  const l = log as Record<string, unknown>;
  return typeof l.seq === "number" && typeof l.leafHash === "string";
}

/**
 * Verify a receipt token against this instance's pepper. Public: the verify
 * page and its API both call this and both are reachable without a session.
 *
 * A token verifies when its signature matches HMAC(SERVER_PEPPER, canonical
 * body) recomputed from the DECODED payload, so re-encoding, key reordering,
 * or whitespace never changes the outcome, but a single altered field or a
 * forged signature fails. The payload is re-canonicalized from the parsed
 * object, not trusted as transmitted.
 */
export function verifyReceipt(token: string): VerifyReceiptResult {
  const raw = (token ?? "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX) {
    return { ok: false, error: "malformed" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64url(parts[1]));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!isValidPayloadShape(payload)) return { ok: false, error: "malformed" };
  if (payload.v !== RECEIPT_VERSION) return { ok: false, error: "unsupported_version" };

  const expected = sign(payload);
  if (!safeEqual(expected, parts[2])) return { ok: false, error: "bad_signature" };
  return { ok: true, receipt: payload };
}

/* --------------------------------------------- engagement certificate (B)
 *
 * BUILDER 2 mechanism B, layered on the receipt above rather than a second
 * artifact. An attested deal's receipt IS the portable engagement certificate,
 * and it exists for BOTH sides: the deal page renders it to every confirmed
 * participant, not only the reporter, so each side walks away with the same
 * signed provenance to show a future counterparty. A solo or claimed deal mints
 * nothing (receiptPayloadForDeal returns null), so the certificate is strictly
 * better for an attested deal than a solo one: a unilateral claim is worth
 * nothing here, exactly as it is worth nothing for reputation and fees.
 *
 * These are pure formatting helpers, kept separate from the receipt-signing
 * functions above (which builder 1 also extends, to carry the transparency-log
 * seq + leaf hash): a change there does not touch the certificate presentation
 * here, and vice versa.
 */

/** Days either party has to dispute an attested deal's record on-platform. */
export const CERTIFICATE_DISPUTE_WINDOW_DAYS = 30;

/** A date, never a time: yyyy-mm-dd (UTC), revealing no more than the day. */
export function certificateDate(attestedAt: number): string {
  return new Date(attestedAt).toISOString().slice(0, 10);
}

/**
 * The one-line provenance a holder shows a future counterparty: tier, blinded
 * buyer, bucketed amount, the confirmed handles, and the date. Every field is
 * already in the signed receipt; this is only how it reads as a track-record
 * line. `buyerShort` is the same short blinded form the deal page renders.
 */
export function provenanceLine(parts: {
  tier: ReceiptTier;
  buyerShort: string;
  buyerIsOther: boolean;
  amountBucket: string;
  participants: string[];
  attestedAt: number;
}): string {
  const tierWord =
    parts.tier === "evidence_committed" ? "evidence-committed" : "co-attested";
  const buyer = `Buyer #${parts.buyerShort}${parts.buyerIsOther ? " (off-list)" : ""}`;
  const who = parts.participants.map((p) => `@${p}`).join(", ");
  return `${tierWord} · ${buyer} · ${parts.amountBucket} · ${who} · ${certificateDate(
    parts.attestedAt,
  )}`;
}
