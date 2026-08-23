/**
 * components/ask/format.ts
 *
 * Pure formatting helpers for ask display. No hooks, no node imports, safe
 * from both server and client components. Anything hash-adjacent stays in
 * lib/crypto.ts; this file only turns numbers into strings.
 */

/** "just now", "4m ago", "3h ago", "2d ago", "5w ago". Ledger-dry. */
export function timeAgo(thenMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - thenMs);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

/** Clamp to an integer 0..100. The one place the slider math lives. */
export function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** The status a given fill percentage implies, absent an explicit close. */
export function statusForPct(pct: number): "open" | "partial" | "closed" {
  const p = clampPct(pct);
  if (p >= 100) return "closed";
  if (p > 0) return "partial";
  return "open";
}
