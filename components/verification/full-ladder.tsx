/**
 * components/verification/full-ladder.tsx
 *
 * The whole verification ladder in one frame: the three rungs running today
 * (labels imported from the deals vocabulary so the words cannot drift) and
 * the three that are research, hatched out so nobody mistakes a roadmap for
 * a feature. Presentational, server-safe.
 */

import { TIER_COPY, TIER_ORDER } from "@/components/deals/format";

type RungState = "running" | "planned";

type Rung = {
  num: string;
  label: string;
  note: string;
  state: RungState;
};

const PLANNED_RUNGS: readonly Rung[] = [
  {
    num: "3",
    label: "payment received",
    note: "posted or released funds on a rail we can re-query: a Stripe bank-transfer invoice carrying a per-deal nonce, or a licensed escrow report",
    state: "planned",
  },
  {
    num: "4",
    label: "payer-bound",
    note: "a structured bank originator matched to the buyer token inside an attested verifier, without the platform ever learning the name",
    state: "planned",
  },
  {
    num: "5",
    label: "escrow-settled",
    note: "funded and released through a licensed escrow agent; never through an account of ours",
    state: "planned",
  },
];

const RUNGS: readonly Rung[] = [
  ...TIER_ORDER.map((t, i) => ({
    num: String(i),
    label: TIER_COPY[t].label,
    note: TIER_COPY[t].short,
    state: "running" as const,
  })),
  ...PLANNED_RUNGS,
];

function StateChip({ state }: { state: RungState }) {
  return (
    <span
      className={[
        "inline-block border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em]",
        state === "running"
          ? "border-amber-soft/50 bg-amber-wash text-amber"
          : "border-rule-strong bg-panel-2 text-ink-faint",
      ].join(" ")}
    >
      {state}
    </span>
  );
}

export function FullLadder() {
  return (
    <div className="border border-rule bg-panel">
      <ol className="divide-y divide-rule">
        {RUNGS.map((r) => (
          <li key={r.num} className="relative">
            {r.state === "planned" ? (
              <div className="bt-hatch pointer-events-none absolute inset-0 opacity-25" />
            ) : null}
            <div className="relative grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-3">
              <span
                className={[
                  "font-mono text-[0.75rem]",
                  r.state === "running" ? "text-amber" : "text-ink-ghost",
                ].join(" ")}
              >
                {r.num}
              </span>
              <div className="min-w-0">
                <span
                  className={[
                    "font-mono text-[0.75rem] uppercase tracking-[0.12em]",
                    r.state === "running" ? "text-ink" : "text-ink-dim",
                  ].join(" ")}
                >
                  {r.label}
                </span>
                <p className="mt-0.5 text-[0.75rem] leading-relaxed text-ink-faint">
                  {r.note}
                </p>
              </div>
              <StateChip state={r.state} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
