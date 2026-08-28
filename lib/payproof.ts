/**
 * lib/payproof.ts
 *
 * The VERIFIABLE proof-of-payment seam (fiat ladder rung F2). It is a seam and
 * a clearly-labeled demo stub, not a shipped verifier: inert until an env flag
 * configures it, exactly like the OTP delivery providers in lib/verify.ts. When
 * nothing is configured the API rung returns 503 and the UI says "verifiable
 * proof-of-payment: planned". Nothing here fakes a bank event.
 *
 * WHAT F2 IS, AND WHERE THE CODE RUNS. The exchange 'pay' step today is F1:
 * a bilateral WireCreditClaim, mutual attestation that a wire carrying the
 * deal's reference was sent and observed. It is honest evidence, not proof a
 * bank credited the money. F2 upgrades that to a real proof of an inbound wire
 * credit, using a zkTLS web proof (the brief's recommendation is ONE Reclaim
 * custom provider against a single known receiving bank, the most productized
 * and browser-verifiable of the options).
 *
 * The trust-preserving shape, from the brief: the SELLER produces the proof
 * against their own bank portal; it travels E2EE to the BUYER; the buyer
 * VERIFIES IT IN THEIR OWN BROWSER (this module's verifier interface, plus the
 * provider's witness-signature check); and the platform logs only a SALTED HASH
 * of the proof envelope plus the normalized, bucketed result and the buyer's
 * acceptance. The server never receives the proof, the bank credentials, the
 * account number, or the exact amount. This mirrors how the E2EE messages and
 * the Tier A exchange already keep raw material off the server.
 *
 * THE PREDICATE (PAYPROOF_PREDICATE below) is what a proof must satisfy to
 * count. It is deliberately strict: an inbound WIRE/CREDIT with a bank terminal
 * status, the exact amount inside the deal's bucket, the rail-safe nonce alias
 * (N15) matched in the reference, a seller-bound recipient-account nullifier, a
 * fresh proof session, and a pinned provider version/hash. A buyer's wire
 * receipt proves only INITIATION and does not satisfy this; even a satisfied
 * predicate is `wire_credit_observed`, never `fiat_final`, because an accepted
 * wire can still be returned, frozen, or reversed (a later wire_reversed event
 * reopens the deal). docs/SETTLEMENT.md carries the full ladder.
 *
 * Dependencies: @noble/hashes (SHA-256) and lib/merkle.ts (canonical JSON), the
 * same isomorphic primitives the exchange uses. No new packages.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes, canonicalJson } from "./merkle.ts";

/* --------------------------------------------------------------- env flags */

/**
 * The only real provider the seam is shaped for is Reclaim (zkTLS). It is
 * "configured" only when the provider is named AND its version/hash is pinned
 * AND the receiving-bank provider template id is set, because the predicate
 * requires all three. A half-set environment is treated as unconfigured, never
 * as a weaker live mode.
 */
function reclaimConfigured(): boolean {
  return (
    process.env.PAYPROOF_PROVIDER === "reclaim" &&
    Boolean(process.env.PAYPROOF_RECLAIM_PROVIDER_ID) &&
    Boolean(process.env.PAYPROOF_PROVIDER_VERSION_HASH)
  );
}

/**
 * The demo transport, off by default. With PAYPROOF_DEMO=1 the demo verifier
 * (below) normalizes a clearly-labeled demo envelope so the exchange flow can be
 * exercised end to end without a bank. Refused outright in production the same
 * way OTP_TEST_CAPTURE is: a demo proof must never stand in for a real one on a
 * live deployment. Throws rather than silently degrade, so a misconfiguration is
 * loud; the API rung catches it and answers 503.
 */
function demoEnabled(): boolean {
  if (process.env.PAYPROOF_DEMO !== "1") return false;
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("PAYPROOF_DEMO is a demo transport. Refusing in production.");
  }
  return true;
}

export type PayProofMode = "unconfigured" | "demo" | "reclaim";

/** Which verifier the environment selects. A real provider wins over the demo. */
export function payProofMode(): PayProofMode {
  if (reclaimConfigured()) return "reclaim";
  if (demoEnabled()) return "demo";
  return "unconfigured";
}

/** Feature check, the OTP-provider Boolean(env) pattern: inert until configured. */
export function payProofConfigured(): boolean {
  return payProofMode() !== "unconfigured";
}

/** The pinned provider version/hash, or null when no real provider is configured. */
export function pinnedProviderVersion(): string | null {
  return reclaimConfigured() ? String(process.env.PAYPROOF_PROVIDER_VERSION_HASH) : null;
}

/* ------------------------------------------------------------ the predicate */

/**
 * The canonical predicate a proof-of-payment must satisfy to count as
 * `wire_credit_observed`. Documented here as the single source of truth; the
 * verifier checks it and the API rung and /transparency/verification cite it.
 * NOT satisfiable by a buyer's wire receipt (initiation only), and satisfying it
 * is still not `fiat_final` (a credit can be reversed).
 */
export const PAYPROOF_PREDICATE: readonly string[] = [
  "inbound WIRE/CREDIT, not a debit and not a pending authorization",
  "exact amount and currency, falling inside the deal's declared amount bucket",
  "the rail-safe nonce alias N15 matched in the End-to-End ID / reference-for-beneficiary",
  "a bank terminal credit status (accepted / credited / posted), not merely initiated",
  "a seller-bound recipient-account nullifier present, with the account number itself hidden",
  "a fresh proof session, so an older witnessed session cannot be replayed",
  "a pinned provider version/hash, so the browser verifier checks a known template",
] as const;

/* ----------------------------------------------------------- result shapes */

export type PayRail = "wire" | "ach" | "swift" | "chips" | "fedwire";

/**
 * The normalized output of a verifier, the shape a real Reclaim custom provider
 * discloses (receiving bank omitted; credentials and account number never
 * present). Bucketed and hashed fields only, nothing the server could not
 * already infer from the deal. `demo` is true ONLY for the demo stub; a real
 * verifier sets it false, and every consumer must carry the flag through so a
 * demo result is never shown or logged as a real proof.
 */
export type PayProofResult = {
  rail: PayRail | string;
  /** Coarse amount bucket, never the exact figure (see usdRounded10k). */
  amountBucket: string;
  /** True when N15 was found in the wire reference the predicate requires. */
  nonceMatched: boolean;
  /** Normalized bank terminal status: "credited" | "posted" | "accepted", or "demo". */
  terminalStatus: string;
  /** Bank value/posting time (epoch ms), or null when the provider does not expose it. */
  postingTime: number | null;
  /** Seller-bound nullifier of the receiving account (hides the account number), or null. */
  accountNullifier: string | null;
  /** When the browser verifier accepted the proof (epoch ms). */
  verifiedAt: number;
  /** True for the demo stub, false for a real proof. Always carried through. */
  demo: boolean;
};

/** The opaque proof envelope a provider emits. Redacted by the provider before signing. */
export type PayProofEnvelope = {
  /** Provider name, e.g. "reclaim" or "demo". */
  provider: string;
  /** The provider version/hash the proof was produced against. */
  version: string;
  /**
   * The provider-specific proof object (Reclaim: the signed claim + witness
   * signatures + context). NEVER carries bank credentials or an account number;
   * the provider redacts to the disclosed fields before it signs.
   */
  claim: unknown;
};

/** What the verifier is told to check the proof against: the deal's expectations. */
export type PayProofContext = {
  dealId: string;
  /** The rail-safe nonce alias the buyer was instructed to put in the wire reference. */
  expectedN15: string;
  /** The deal's declared amount bucket the credited amount must fall inside. */
  expectedAmountBucket: string;
  /** The rail the wire was expected on. */
  expectedRail: PayRail | string;
  /** When the proof session was opened (epoch ms), for the freshness check. */
  sessionOpenedAt: number;
  /** The seller-bound account nullifier the proof must carry, or null if not yet pinned. */
  sellerAccountNullifier: string | null;
};

export type PayProofFailure =
  | "unconfigured"
  | "bad_envelope"
  | "provider_mismatch"
  | "version_unpinned"
  | "predicate_failed"
  | "stale_session"
  | "not_implemented";

export type PayProofVerification =
  | { ok: true; result: PayProofResult }
  | { ok: false; reason: PayProofFailure; failures?: string[] };

/**
 * A verifier: given a proof envelope and the deal's expectations, either
 * normalizes it to a PayProofResult or returns a typed failure. It runs in the
 * BUYER'S BROWSER; the server never calls verify() because the proof is E2EE and
 * the server holds nothing to check it with. Never throws.
 */
export interface PayProofVerifier {
  readonly name: PayProofMode;
  verify(env: PayProofEnvelope, ctx: PayProofContext): Promise<PayProofVerification>;
}

/* --------------------------------------------------------- predicate check */

/** Basic envelope well-formedness, before any provider-specific verification. */
export function isPayProofEnvelope(v: unknown): v is PayProofEnvelope {
  if (v === null || typeof v !== "object") return false;
  const e = v as PayProofEnvelope;
  return typeof e.provider === "string" && typeof e.version === "string" && "claim" in e;
}

/** How stale a proof session may be before freshness fails: one hour. */
export const PAYPROOF_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Check a normalized result against the deal's expectations. This is the
 * predicate as code: the same list PAYPROOF_PREDICATE states in prose. Returns
 * the specific clauses that failed, so the UI can say exactly what was wrong
 * rather than a bare boolean.
 */
export function checkPredicate(
  result: PayProofResult,
  ctx: PayProofContext,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (String(result.rail).toLowerCase() !== String(ctx.expectedRail).toLowerCase()) {
    failures.push("rail does not match the expected wire rail");
  }
  if (result.amountBucket !== ctx.expectedAmountBucket) {
    failures.push("credited amount is outside the deal's declared bucket");
  }
  if (!result.nonceMatched) {
    failures.push("the nonce alias N15 was not matched in the wire reference");
  }
  const terminal = new Set(["credited", "posted", "accepted"]);
  if (!terminal.has(String(result.terminalStatus).toLowerCase())) {
    failures.push("bank status is not a terminal credit (credited / posted / accepted)");
  }
  if (ctx.sellerAccountNullifier !== null && result.accountNullifier !== ctx.sellerAccountNullifier) {
    failures.push("the receiving-account nullifier is not the seller-bound one");
  }
  if (result.verifiedAt - ctx.sessionOpenedAt > PAYPROOF_SESSION_TTL_MS) {
    failures.push("the proof session is stale (older than the freshness window)");
  }
  return { ok: failures.length === 0, failures };
}

/* ------------------------------------------------------------- demo stub */

/**
 * The demo verifier. It does NOT contact a bank and asserts nothing about real
 * money. It normalizes a demo envelope into a result carrying the deal's own
 * expectations, with demo:true and terminalStatus:"demo", purely so the pay
 * step can be walked end to end on a dev instance. Every consumer must keep the
 * demo flag visible: this is never presented or logged as a real proof.
 */
class DemoPayProofVerifier implements PayProofVerifier {
  readonly name = "demo" as const;
  async verify(env: PayProofEnvelope, ctx: PayProofContext): Promise<PayProofVerification> {
    if (!isPayProofEnvelope(env)) return { ok: false, reason: "bad_envelope" };
    if (env.provider !== "demo") return { ok: false, reason: "provider_mismatch" };
    const result: PayProofResult = {
      rail: ctx.expectedRail,
      amountBucket: ctx.expectedAmountBucket,
      nonceMatched: true,
      terminalStatus: "demo",
      postingTime: null,
      accountNullifier: ctx.sellerAccountNullifier,
      verifiedAt: Date.now(),
      demo: true,
    };
    return { ok: true, result };
  }
}

/**
 * The Reclaim verifier's PLACEHOLDER. A real implementation would, in the
 * buyer's browser: check the witness signatures and the pinned provider
 * version/hash, parse the disclosed fields (rail, amount, currency, reference,
 * terminal status, posting time, account nullifier) out of the signed claim,
 * bucket the amount, and return the normalized result for checkPredicate. It is
 * intentionally NOT implemented here, because faking that verification would be
 * exactly the dishonest thing this seam exists to avoid, and Reclaim's browser
 * verifier is not a dependency of this repo. Configuring PAYPROOF_PROVIDER=
 * reclaim therefore makes the rung answer 503 with "verifier not implemented"
 * until the real integration lands, never a fabricated pass.
 */
class ReclaimPayProofVerifier implements PayProofVerifier {
  readonly name = "reclaim" as const;
  async verify(): Promise<PayProofVerification> {
    return { ok: false, reason: "not_implemented" };
  }
}

/** The verifier the environment selects, or null when unconfigured. */
export function getPayProofVerifier(): PayProofVerifier | null {
  switch (payProofMode()) {
    case "reclaim":
      return new ReclaimPayProofVerifier();
    case "demo":
      return new DemoPayProofVerifier();
    default:
      return null;
  }
}

/* --------------------------------------------------------- server logging */

/**
 * A salted hash of the proof envelope, computed in the buyer's browser. The
 * server stores this hash (never the envelope): it is enough to bind the proof
 * to the deal and to re-check a later challenge, and reveals nothing. The salt
 * stays with the parties so a hidden dictionary of envelopes cannot be
 * confirmed against the log.
 */
export function payProofHash(salt: Uint8Array, env: PayProofEnvelope): string {
  const body = utf8ToBytes(canonicalJson(env));
  const buf = new Uint8Array(salt.length + body.length);
  buf.set(salt, 0);
  buf.set(body, salt.length);
  return bytesToHex(sha256(buf));
}

/**
 * The ONLY thing the platform records for a proof-of-payment: the salted hash,
 * the normalized bucketed result, and the buyer's acceptance. No envelope, no
 * amount, no account, no credential. This is the object bound into the exchange
 * chain once F2 is wired; the seam returns it so the integration point is a hash
 * and an acceptance flag, nothing richer.
 */
export type PayProofRecord = {
  proofHash: string;
  rail: string;
  amountBucket: string;
  nonceMatched: boolean;
  terminalStatus: string;
  verifiedAt: number;
  /** The buyer's countersignature of acceptance is what advances the deal. */
  accepted: boolean;
  /** Carried through so a demo proof is never mistaken for a real one. */
  demo: boolean;
};

/** Reduce a verified result plus its salted hash to the minimal server record. */
export function toPayProofRecord(
  proofHash: string,
  result: PayProofResult,
  accepted: boolean,
): PayProofRecord {
  return {
    proofHash,
    rail: String(result.rail),
    amountBucket: result.amountBucket,
    nonceMatched: result.nonceMatched,
    terminalStatus: result.terminalStatus,
    verifiedAt: result.verifiedAt,
    accepted,
    demo: result.demo,
  };
}

/* ---------------------------------------------------------------- status */

/** The public status of the rung, for the API and the UI note. No secrets. */
export type PayProofStatus = {
  configured: boolean;
  mode: PayProofMode;
  /** Human phrase the UI shows verbatim. */
  label: string;
  /** The pinned provider version/hash when a real provider is configured. */
  providerVersion: string | null;
  predicate: readonly string[];
};

/**
 * Resolve the rung's status. Catches the demo-in-production refusal so a
 * status read never 500s; a misconfigured production demo reads as unconfigured
 * (the throw is still logged by the caller that tried to verify).
 */
export function payProofStatus(): PayProofStatus {
  let mode: PayProofMode;
  try {
    mode = payProofMode();
  } catch {
    mode = "unconfigured";
  }
  const label =
    mode === "reclaim"
      ? "verifiable proof-of-payment: active"
      : mode === "demo"
        ? "verifiable proof-of-payment: demo (not a real proof)"
        : "verifiable proof-of-payment: planned";
  return {
    configured: mode !== "unconfigured",
    mode,
    label,
    providerVersion: pinnedProviderVersion(),
    predicate: PAYPROOF_PREDICATE,
  };
}
