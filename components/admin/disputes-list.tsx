"use client";

/**
 * components/admin/disputes-list.tsx
 *
 * The /admin ledger of open referral disputes. Each row: who owes whom, who
 * raised it, when, whether its gate-lift window has lapsed, and two rulings.
 * Uphold sides with the disputer (the pair's gate stays lifted); reject lets
 * the debt stand (the gate returns). Rows come serialized from the server
 * component; a ruling POSTs to the API and refreshes.
 *
 * Handles and timestamps only, per the schema's rules: a dispute is a pair,
 * not an amount, and no dollar figure crosses into this panel.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { timeAgo } from "@/components/ask/format";

export type DisputeRow = {
  disputeId: string;
  payerUsername: string;
  payeeUsername: string;
  raisedByUsername: string;
  raisedAt: number;
  windowExpired: boolean;
};

export function DisputesList({ rows }: { rows: DisputeRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nowMs = Date.now();

  async function resolve(disputeId: string, ruling: "uphold" | "reject") {
    setBusyId(disputeId);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/disputes/${encodeURIComponent(disputeId)}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ruling }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Ruling failed.");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="border border-rule bg-panel">
      <div className="flex items-baseline justify-between border-b border-rule px-5 py-3">
        <span className="bt-label">Open disputes</span>
        <span className="font-mono text-[0.6875rem] text-amber">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-4 text-[0.8125rem] leading-relaxed text-ink-faint">
          No open disputes. A raised pair appears here until you uphold or
          reject it; upholding keeps the payer&apos;s gate lifted, rejecting
          lets the debt gate again.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {rows.map((r) => (
            <li key={r.disputeId} className="px-5 py-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-mono text-[0.8125rem] text-ink">
                  @{r.payerUsername} owes @{r.payeeUsername}
                  {r.windowExpired ? (
                    <span className="ml-2 bg-red-wash px-1.5 py-0.5 font-mono text-[0.625rem] text-red">
                      window lapsed, gating again
                    </span>
                  ) : null}
                </span>
                <span className="inline-flex gap-2">
                  <button
                    type="button"
                    onClick={() => resolve(r.disputeId, "uphold")}
                    disabled={busyId !== null}
                    className="bt-btn px-3 py-1 text-[0.6875rem]"
                  >
                    {busyId === r.disputeId ? "Ruling" : "Uphold"}
                  </button>
                  <button
                    type="button"
                    onClick={() => resolve(r.disputeId, "reject")}
                    disabled={busyId !== null}
                    className="bt-btn px-3 py-1 text-[0.6875rem]"
                  >
                    {busyId === r.disputeId ? "Ruling" : "Reject"}
                  </button>
                </span>
              </div>
              <div className="mt-1 font-mono text-[0.6875rem] text-ink-ghost">
                raised by @{r.raisedByUsername} · {timeAgo(r.raisedAt, nowMs)}
              </div>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <div className="border-t border-red/40 bg-red-wash px-5 py-3 text-[0.75rem] text-ink">
          {error}
        </div>
      ) : null}
    </div>
  );
}
