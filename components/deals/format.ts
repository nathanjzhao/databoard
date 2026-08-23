/**
 * components/deals/format.ts
 *
 * Pure formatting for the deals UI. No hooks, no server imports, safe from
 * both server pages and client components. The tier vocabulary lives here so
 * every surface uses the exact same words; in particular, nothing in this
 * file or anywhere else may render "verified" for a co-attested deal.
 */

export type DealTierName = "claimed" | "co_attested" | "evidence_committed";
export type ShareStatusName = "pending" | "confirmed" | "declined";

/** Exact dollars, mono-friendly: "$1,234,567". Participants-only surfaces. */
export function usdExact(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * The public rounding rule: nearest $10k, and everything under $10k renders
 * as "<$10k". Exact figures stay on the deal pages, for the deal's own
 * participants.
 */
export function usdRounded10k(n: number): string {
  if (n < 10_000) return "<$10k";
  const rounded = Math.round(n / 10_000) * 10_000;
  if (rounded >= 1_000_000) {
    const m = rounded / 1_000_000;
    return `$${Number.isInteger(m) ? m : m.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
  }
  return `$${Math.round(rounded / 1000)}k`;
}

/* ------------------------------------------------------------------ tiers */

/** The ladder, in order. Copy comes from TIER_COPY, never inline. */
export const TIER_ORDER: readonly DealTierName[] = [
  "claimed",
  "co_attested",
  "evidence_committed",
] as const;

export const TIER_COPY: Record<
  DealTierName,
  { label: string; short: string; explain: string }
> = {
  claimed: {
    label: "claimed",
    short: "one account says so",
    explain:
      "The reporter typed it in. Nobody else has signed off. A claimed deal never surfaces publicly beyond the reporter's own self value.",
  },
  co_attested: {
    label: "co-attested",
    short: "every named account signed off",
    explain:
      "Every non-declined participant confirmed their own share from their own account. Co-attested means the accounts agree with each other; it does not mean verified.",
  },
  evidence_committed: {
    label: "evidence committed",
    short: "hashes on file, not yet independently verified",
    explain:
      "On top of co-attestation, the reporter and every confirmed participant each committed a SHA-256 of an official document, hashed in their own browser. The platform holds the fingerprints, never the documents. Evidence committed, not yet independently verified.",
  },
};

export function tierIndex(tier: DealTierName): number {
  return TIER_ORDER.indexOf(tier);
}

/* ----------------------------------------------------------- share status */

export const SHARE_STATUS_COPY: Record<ShareStatusName, string> = {
  pending: "pending",
  confirmed: "confirmed",
  declined: "declined",
};

/** "3 of 4 confirmed", "solo deal" when nobody else was named. */
export function confirmedFraction(k: number, n: number): string {
  if (n === 0) return "solo deal";
  return `${k} of ${n} confirmed`;
}

/** First 12 hex characters of a commitment, for table cells. */
export function hashShort(hash: string): string {
  return hash.slice(0, 12);
}
