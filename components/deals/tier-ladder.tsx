/**
 * components/deals/tier-ladder.tsx
 *
 * The verification ladder for one deal: claimed, co-attested, evidence
 * committed, with the current rung lit. Presentational only. The words come
 * from TIER_COPY and nowhere else; "verified" appears only inside the phrase
 * "not yet independently verified", which is the point.
 */

import type { DealTier } from "@/lib/deals";
import { TIER_COPY, TIER_ORDER, tierIndex } from "@/components/deals/format";

/** The one-word tier chip list rows wear. */
export function TierTag({ tier }: { tier: DealTier }) {
  const style =
    tier === "evidence_committed"
      ? "border-green/50 bg-green-wash text-green"
      : tier === "co_attested"
        ? "border-amber-soft/50 bg-amber-wash text-amber"
        : "border-rule-strong bg-panel-2 text-ink-faint";
  return (
    <span
      className={[
        "inline-block border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em]",
        style,
      ].join(" ")}
      title={TIER_COPY[tier].short}
    >
      {TIER_COPY[tier].label}
    </span>
  );
}

export function TierLadder({
  tier,
  solo,
}: {
  tier: DealTier;
  /** Solo deals never climb; say so instead of showing dead rungs. */
  solo: boolean;
}) {
  const current = tierIndex(tier);
  return (
    <div>
      <ol className="flex flex-col gap-0 sm:flex-row sm:items-stretch">
        {TIER_ORDER.map((t, i) => {
          const reached = i <= current;
          const active = i === current;
          return (
            <li key={t} className="flex flex-1 items-stretch">
              <div
                className={[
                  "flex-1 border px-4 py-3",
                  active
                    ? "border-ink bg-ink"
                    : reached
                      ? "border-rule-strong bg-panel-2"
                      : "border-rule bg-panel",
                ].join(" ")}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className={[
                      "font-mono text-[0.625rem]",
                      active ? "text-void" : reached ? "text-amber" : "text-ink-ghost",
                    ].join(" ")}
                  >
                    {i}
                  </span>
                  <span
                    className={[
                      "font-mono text-[0.6875rem] uppercase tracking-[0.12em]",
                      active ? "text-void" : reached ? "text-ink-dim" : "text-ink-ghost",
                    ].join(" ")}
                  >
                    {TIER_COPY[t].label}
                  </span>
                </div>
                <p
                  className={[
                    "mt-1 text-[0.6875rem] leading-snug",
                    active ? "text-void/70" : reached ? "text-ink-faint" : "text-ink-ghost",
                  ].join(" ")}
                >
                  {TIER_COPY[t].short}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-faint">
        {solo
          ? "Solo deal: with nobody else named, this stays a claimed-tier entry no matter what. It counts toward your own figures only."
          : TIER_COPY[tier].explain}
      </p>
    </div>
  );
}
