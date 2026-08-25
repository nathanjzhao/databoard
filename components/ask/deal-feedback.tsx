/**
 * components/ask/deal-feedback.tsx
 *
 * What confirmed deals feed back onto the ask page. Two pieces:
 *
 *   ConfirmedDealsNote  every viewer: "N confirmed deals reference this
 *                       ask". A count and nothing else; amounts stay with
 *                       the people on the deals.
 *   OwnerDealBanner     the poster: a confirmed deal means the board just
 *                       moved on their ask, so the meter is probably stale.
 *                       Links straight to their own controls.
 *
 * Presentational, no hooks, server-safe. "Confirmed" here means the deal
 * stands at co-attested or better; the wording never says "verified".
 */

export function ConfirmedDealsNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-rule bg-panel px-5 py-3.5">
      <span className="font-mono text-[1.25rem] leading-none tabular-nums text-green">
        {count}
      </span>
      <span className="text-[0.8125rem] text-ink-dim">
        confirmed {count === 1 ? "deal references" : "deals reference"} this
        ask.
      </span>
      <span className="text-[0.75rem] text-ink-faint">
        A count, nothing more. Amounts stay with the people on them.
      </span>
    </div>
  );
}

export function OwnerDealBanner({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="mt-6 border-l-2 border-green bg-green-wash px-4 py-3">
      <p className="text-[0.8125rem] leading-relaxed text-ink-dim">
        {count === 1
          ? "A confirmed deal references this ask."
          : `${count} confirmed deals reference this ask.`}{" "}
        If supply moved,{" "}
        <a href="#owner-controls" className="text-blue underline hover:text-amber">
          update the meter or close it
        </a>{" "}
        so the board reads true.
      </p>
    </div>
  );
}
