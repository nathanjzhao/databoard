"use client";

/**
 * components/admin/hide-control.tsx
 *
 * The operator's hide control on an ask page. Quiet on purpose: one small
 * line until clicked, then a reason box and a confirm. The reason is shown
 * verbatim to the poster and on /admin, and the form says so, along with
 * the rule that matters: no contact details, no names, nothing the schema
 * refuses to store. A reason names a problem, not a person.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function HideControl({ askId }: { askId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function hide() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/asks/${askId}/hide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Hide failed.");
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-ink-ghost">
          operator
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-mono text-[0.6875rem] text-ink-faint transition-colors hover:text-red"
        >
          Hide
        </button>
      </div>
    );
  }

  return (
    <div className="border border-rule bg-panel">
      <div className="flex items-baseline justify-between border-b border-rule px-4 py-2.5">
        <span className="bt-label">Hide this ask</span>
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-ink-ghost">
          operator
        </span>
      </div>
      <div className="px-4 py-3.5">
        <label
          htmlFor={`hide-reason-${askId}`}
          className="text-[0.75rem] leading-relaxed text-ink-dim"
        >
          Reason. The poster reads it, word for word.
        </label>
        <textarea
          id={`hide-reason-${askId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={500}
          className="mt-2 w-full resize-y border border-rule-strong bg-panel-2 px-3 py-2 text-[0.8125rem] text-ink focus:border-ink-ghost focus:outline-none"
          placeholder="e.g. spam, or solicits off-board contact"
        />
        <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-ink-ghost">
          No contact details, no names, no quoted PII. Name the problem, not
          the person; the database holds this text forever.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={hide}
            disabled={busy || reason.trim().length === 0}
            className="bt-btn border-red bg-red-wash px-4 py-1.5 text-[0.75rem] text-red hover:border-red"
          >
            {busy ? "Hiding" : "Hide from the board"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            disabled={busy}
            className="text-[0.75rem] text-ink-faint hover:text-ink-dim"
          >
            cancel
          </button>
        </div>
        {error ? <p className="mt-2 text-[0.75rem] text-red">{error}</p> : null}
      </div>
    </div>
  );
}
