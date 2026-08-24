"use client";

/**
 * components/admin/moderation-banner.tsx
 *
 * The banner on a hidden ask's page. Two audiences see it: the poster, who
 * deserves to know their ask is off the board and why, and an operator, who
 * gets the unhide button. Everyone else gets a 404 before this renders.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ModerationBanner({
  askId,
  reason,
  canUnhide,
}: {
  askId: string;
  reason: string;
  canUnhide: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unhide() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/asks/${askId}/unhide`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unhide failed.");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 border border-red/40 bg-red-wash px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-red">
          hidden by moderation
        </span>
        {canUnhide ? (
          <button
            type="button"
            onClick={unhide}
            disabled={busy}
            className="bt-btn px-3 py-1 text-[0.6875rem]"
          >
            {busy ? "Unhiding" : "Unhide"}
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink">
        hidden by moderation: {reason}
      </p>
      {canUnhide ? null : (
        <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-dim">
          Off the board, out of matching, invisible to other members. You still
          see it here, with the reason, because silent removal is worse.
        </p>
      )}
      {error ? <p className="mt-2 text-[0.75rem] text-red">{error}</p> : null}
    </div>
  );
}
