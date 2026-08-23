/**
 * components/deals/split-table.tsx
 *
 * The full split of a deal: one row per person, reporter first, exact
 * dollars in mono. Presentational only, no hooks, no server imports, so both
 * server pages and client cards can render it. Exact figures are fine here
 * because everything that renders this table is participant-only.
 */

import type { SplitRow } from "@/lib/deals";
import { hashShort, usdExact } from "@/components/deals/format";
import { ScrollPane } from "@/components/deals/scroll-pane";

const STATUS_STYLE: Record<SplitRow["status"], string> = {
  pending: "text-amber",
  confirmed: "text-green",
  declined: "text-ink-ghost line-through",
};

export function SplitTable({
  split,
  totalUsd,
  viewerId,
}: {
  split: SplitRow[];
  totalUsd: number;
  viewerId: string;
}) {
  const allocated = split
    .filter((r) => r.status !== "declined")
    .reduce((s, r) => s + r.shareUsd, 0);
  const remainder = totalUsd - allocated;

  return (
    <ScrollPane>
      <table className="w-full min-w-[520px] border-collapse text-left">
        <thead>
          <tr className="border-b border-rule-strong">
            <th className="bt-label py-2 pr-4 font-normal">Who</th>
            <th className="bt-label py-2 pr-4 font-normal">Role</th>
            <th className="bt-label py-2 pr-4 text-right font-normal">Share</th>
            <th className="bt-label py-2 pr-4 font-normal">Status</th>
            <th className="bt-label py-2 font-normal">Evidence</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {split.map((r) => {
            const mine = r.userId === viewerId;
            return (
              <tr key={r.userId} className={mine ? "bg-panel-2" : undefined}>
                <td className="py-2.5 pr-4">
                  <span
                    className={[
                      "font-mono text-[0.75rem]",
                      mine ? "text-amber" : "text-ink-dim",
                    ].join(" ")}
                  >
                    @{r.username}
                  </span>
                  {mine ? (
                    <span className="ml-2 bt-label text-ink-ghost">you</span>
                  ) : null}
                </td>
                <td className="py-2.5 pr-4 text-[0.6875rem] uppercase tracking-[0.08em] text-ink-faint">
                  {r.role === "reporter" ? "reporter" : "participant"}
                </td>
                <td
                  className={[
                    "py-2.5 pr-4 text-right font-mono text-[0.8125rem] tabular-nums",
                    r.status === "declined" ? "text-ink-ghost line-through" : "text-ink",
                  ].join(" ")}
                >
                  {usdExact(r.shareUsd)}
                </td>
                <td className="py-2.5 pr-4">
                  <span
                    className={[
                      "font-mono text-[0.6875rem] uppercase tracking-[0.1em]",
                      STATUS_STYLE[r.status],
                    ].join(" ")}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="py-2.5">
                  {r.evidenceHash ? (
                    <span
                      className="inline-flex items-baseline gap-2"
                      title={`SHA-256 ${r.evidenceHash}`}
                    >
                      <span className="bt-token">{hashShort(r.evidenceHash)}…</span>
                      {r.evidenceLabel ? (
                        <span className="text-[0.6875rem] text-ink-faint">
                          {r.evidenceLabel}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-[0.6875rem] text-ink-ghost">none</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-rule-strong">
            <td className="py-2.5 pr-4 text-[0.6875rem] text-ink-faint" colSpan={2}>
              Unallocated remainder
            </td>
            <td className="py-2.5 pr-4 text-right font-mono text-[0.8125rem] tabular-nums text-ink-faint">
              {usdExact(Math.max(0, remainder))}
            </td>
            <td className="py-2.5 pr-4" colSpan={2}>
              <span className="text-[0.6875rem] text-ink-ghost">
                of {usdExact(totalUsd)} total
              </span>
            </td>
          </tr>
        </tfoot>
      </table>
    </ScrollPane>
  );
}
