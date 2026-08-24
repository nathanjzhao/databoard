"use client";

/**
 * components/admin/hidden-list.tsx
 *
 * The /admin ledger of hidden asks. Each row: the ask, who posted it, who
 * hid it, why, and an unhide button. Rows come serialized from the server
 * component; unhide posts to the API and refreshes.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { timeAgo } from "@/components/ask/format";

export type HiddenRow = {
  askId: string;
  title: string;
  posterUsername: string;
  reason: string;
  hiddenAt: number;
  hiddenByUsername: string;
};

export function HiddenList({ rows }: { rows: HiddenRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nowMs = Date.now();

  async function unhide(askId: string) {
    setBusyId(askId);
    setError(null);
    try {
      const res = await fetch(`/api/admin/asks/${askId}/unhide`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unhide failed.");
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
        <span className="bt-label">Hidden asks</span>
        <span className="font-mono text-[0.6875rem] text-amber">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-4 text-[0.8125rem] leading-relaxed text-ink-faint">
          Nothing is hidden. The board is exactly what everyone sees.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {rows.map((r) => (
            <li key={r.askId} className="px-5 py-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <Link
                  href={`/ask/${r.askId}`}
                  className="min-w-0 truncate text-[0.875rem] text-ink transition-colors hover:text-amber"
                >
                  {r.title}
                </Link>
                <button
                  type="button"
                  onClick={() => unhide(r.askId)}
                  disabled={busyId !== null}
                  className="bt-btn px-3 py-1 text-[0.6875rem]"
                >
                  {busyId === r.askId ? "Unhiding" : "Unhide"}
                </button>
              </div>
              <div className="mt-1 font-mono text-[0.6875rem] text-ink-ghost">
                by @{r.posterUsername} · hidden by @{r.hiddenByUsername}{" "}
                {timeAgo(r.hiddenAt, nowMs)}
              </div>
              <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-dim">
                {r.reason}
              </p>
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
