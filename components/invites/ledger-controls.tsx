"use client";

/**
 * components/invites/ledger-controls.tsx
 *
 * The client-side verbs on the referral ledger, all of them recording only:
 *
 *   RecordSettlementForm   payee side: "I received $X off the platform"
 *   ConfirmSettlementButton payer side: co-sign a recorded settlement
 *   DisputeButton           either side: mark the pair disputed, one click
 *
 * Each POSTs and refreshes; the figures themselves are computed server-side
 * on every render, never held in client state.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Payee records money received from a downline payer. Inline reveal form. */
export function RecordSettlementForm({ payerUsername }: { payerUsername: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amountUsd = Number(amount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      setError("A dollar amount above zero.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invites/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "record",
          payerUsername,
          amountUsd,
          note,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not record that. Try again.");
        return;
      }
      setOpen(false);
      setAmount("");
      setNote("");
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="bt-btn px-2.5 py-1 text-[0.6875rem]"
      >
        Record settlement
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2">
      <input
        className="bt-input w-28 px-2 py-1 font-mono text-[0.75rem]"
        inputMode="decimal"
        placeholder="0.00"
        autoFocus
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <input
        className="bt-input w-44 px-2 py-1 text-[0.75rem]"
        placeholder="note (optional)"
        maxLength={200}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        type="submit"
        disabled={busy}
        className="bt-btn bt-btn-primary px-3 py-1 text-[0.6875rem]"
      >
        {busy ? "Recording…" : "Record received"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
        className="bt-btn px-2.5 py-1 text-[0.6875rem]"
      >
        Cancel
      </button>
      {error ? <span className="w-full text-[0.6875rem] text-red">{error}</span> : null}
    </form>
  );
}

/** Payer co-signs a settlement the payee recorded. */
export function ConfirmSettlementButton({ settlementId }: { settlementId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invites/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm", settlementId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not confirm. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={confirm}
        disabled={busy}
        className="bt-btn px-2.5 py-1 text-[0.6875rem]"
      >
        {busy ? "Confirming…" : "Confirm"}
      </button>
      {error ? <span className="text-[0.6875rem] text-red">{error}</span> : null}
    </span>
  );
}

/** One click, either party. Lifts the standing block and flags operators. */
export function DisputeButton({ withUsername }: { withUsername: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dispute() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invites/dispute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ withUsername }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not raise that. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={dispute}
        disabled={busy}
        className="bt-btn px-2.5 py-1 text-[0.6875rem]"
        title="Marks this pair disputed and flags operators. Both of you will see it."
      >
        {busy ? "Raising…" : "Dispute"}
      </button>
      {error ? <span className="text-[0.6875rem] text-red">{error}</span> : null}
    </span>
  );
}
