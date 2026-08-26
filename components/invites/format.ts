/**
 * components/invites/format.ts
 *
 * Pure formatting for the invites and referral-ledger UI. No hooks, no
 * server imports; safe from server pages and client components alike.
 *
 * The display contract from lib/referrals.ts: arithmetic is exact integer
 * cents, DISPLAY rounds to whole dollars. Nothing here ever prints cents.
 */

/** Whole-dollar display of an integer-cents figure: "$6,625". */
export function usdWhole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/**
 * The rate at a chain depth. 2.5% and 0.0625% are printed as themselves;
 * deeper steps print as powers, because "0.0015625%" reads worse than it
 * informs. The exact rule is 2.5%^depth either way.
 */
export function rateLabel(depth: number): string {
  if (depth === 1) return "2.5%";
  if (depth === 2) return "0.0625%";
  return `2.5%^${depth}`;
}

/** "step 1", "step 3": how far down (or up) the chain a pair sits. */
export function depthLabel(depth: number): string {
  return `step ${depth}`;
}
