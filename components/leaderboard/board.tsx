"use client";

/**
 * components/leaderboard/board.tsx
 *
 * The ranking table. Client-side only for one reason: re-sorting by column
 * without a round trip. It never holds an exact dollar figure; the server
 * hands it nearest-$10k strings plus a precomputed 1-based rank per metric,
 * and sorting is just "order by that rank". The exact sums that decided the
 * order stay on the server, which is the whole point.
 */

import { useState } from "react";
import type { LeaderboardSortKey, PublicLeaderboardRow } from "@/lib/stats";
import { ScrollPane } from "@/components/deals/scroll-pane";

const COLUMNS: {
  key: LeaderboardSortKey;
  label: string;
  hint: string;
}[] = [
  {
    key: "collaborators",
    label: "Brought in",
    hint: "Distinct confirmed counterparties on deals this account reported. A repeat pair counts once per 30 days.",
  },
  {
    key: "value_to_others",
    label: "To others",
    hint: "Confirmed participants' shares on deals this account reported. Rounded to the nearest $10k.",
  },
  {
    key: "value_to_self",
    label: "To self",
    hint: "Own counted shares, reported and confirmed. Rounded to the nearest $10k.",
  },
];

export function LeaderboardBoard({
  rows,
  viewerUsername,
}: {
  rows: PublicLeaderboardRow[];
  viewerUsername: string;
}) {
  // Default to the network-contribution headline: value brought to others, not
  // raw self value. Bringing deals TO people is what the board rewards first.
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>("value_to_others");
  const ordered = [...rows].sort((a, b) => a.ranks[sortKey] - b.ranks[sortKey]);

  return (
    <ScrollPane className="border border-rule bg-panel">
      <table className="w-full min-w-[680px] border-collapse text-left">
        <thead>
          <tr className="border-b border-rule-strong bg-panel-2/60">
            <th className="bt-label w-14 py-2.5 pl-5 pr-3 font-normal">Rank</th>
            <th className="bt-label py-2.5 pr-4 font-normal">Account</th>
            {COLUMNS.map((c) => {
              const active = c.key === sortKey;
              return (
                <th
                  key={c.key}
                  className="py-0 pr-4 text-right font-normal"
                  aria-sort={active ? "descending" : "none"}
                >
                  <button
                    type="button"
                    onClick={() => setSortKey(c.key)}
                    title={c.hint}
                    className={[
                      "bt-label cursor-pointer py-2.5 transition-colors",
                      active ? "text-amber" : "hover:text-ink-dim",
                    ].join(" ")}
                  >
                    {c.label}
                    <span
                      className={[
                        "ml-1 inline-block",
                        active ? "text-amber" : "text-ink-ghost",
                      ].join(" ")}
                    >
                      {active ? "▾" : "·"}
                    </span>
                  </button>
                </th>
              );
            })}
            <th
              className="bt-label py-2.5 pr-4 text-right font-normal"
              title="Deals at evidence-committed tier this account is a confirmed party to. Hashes on file, not yet independently verified."
            >
              Evidence
            </th>
            <th
              className="bt-label py-2.5 pr-5 text-right font-normal text-ink-faint"
              title="Solo, unattested claims: deals with no named counterparty. Worth nothing for reputation or fees, so this column never sorts the board and carries no rank."
            >
              Claimed
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {ordered.map((row) => {
            const rank = row.ranks[sortKey];
            const mine = row.username === viewerUsername;
            return (
              <tr
                key={row.username}
                className={
                  mine
                    ? "bg-panel-2 [box-shadow:inset_2px_0_0_var(--bt-amber)]"
                    : "transition-colors hover:bg-panel-2/50"
                }
              >
                <td
                  className={[
                    "py-3 pl-5 pr-3 font-mono text-[0.8125rem] tabular-nums",
                    rank === 1
                      ? "text-amber"
                      : rank <= 3
                        ? "text-ink"
                        : "text-ink-faint",
                  ].join(" ")}
                >
                  {String(rank).padStart(2, "0")}
                </td>
                <td className="py-3 pr-4">
                  <span
                    className={[
                      "font-mono text-[0.8125rem]",
                      mine ? "text-amber" : "text-ink",
                    ].join(" ")}
                  >
                    @{row.username}
                  </span>
                  {mine ? (
                    <span className="ml-2 bt-label text-ink-ghost">you</span>
                  ) : null}
                </td>
                <td
                  className={[
                    "py-3 pr-4 text-right font-mono text-[0.875rem] tabular-nums",
                    sortKey === "collaborators" ? "text-ink" : "text-ink-dim",
                  ].join(" ")}
                >
                  {row.collaborators}
                </td>
                <td
                  className={[
                    "py-3 pr-4 text-right font-mono text-[0.875rem] tabular-nums",
                    sortKey === "value_to_others" ? "text-ink" : "text-ink-dim",
                  ].join(" ")}
                >
                  {row.valueToOthers}
                </td>
                <td
                  className={[
                    "py-3 pr-4 text-right font-mono text-[0.875rem] tabular-nums",
                    sortKey === "value_to_self" ? "text-ink" : "text-ink-dim",
                  ].join(" ")}
                >
                  {row.valueToSelf}
                </td>
                <td className="py-3 pr-4 text-right">
                  {row.evidenceCommittedDeals > 0 ? (
                    <span
                      className="inline-block border border-green/50 bg-green-wash px-1.5 py-0.5 font-mono text-[0.625rem] tabular-nums text-green"
                      title="Deals at evidence-committed tier: hashes on file, not yet independently verified."
                    >
                      {row.evidenceCommittedDeals}
                    </span>
                  ) : (
                    <span className="font-mono text-[0.75rem] text-ink-ghost">0</span>
                  )}
                </td>
                <td
                  className="py-3 pr-5 text-right font-mono text-[0.8125rem] tabular-nums text-ink-faint"
                  title="Solo claims. No rank."
                >
                  {row.claimedUnattested ? (
                    row.claimedUnattested
                  ) : (
                    <span className="text-ink-ghost">·</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollPane>
  );
}
