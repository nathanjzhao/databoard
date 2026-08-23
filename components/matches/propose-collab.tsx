"use client";

/**
 * The "I have some of that" button on a matched ask. Expands into a short
 * note box, files the collab request, and then shows where the request
 * stands. A pending request can be withdrawn from here; a declined one is
 * final and says so.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

type Phase = "idle" | "composing" | "sending" | "sent" | "withdrawing";

export function ProposeCollab({
  askId,
  existingStatus,
  requestId,
}: {
  askId: string;
  /** The viewer's prior request on this ask, if any. */
  existingStatus: "pending" | "accepted" | "declined" | "withdrawn" | null;
  requestId?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPhase("sending");
    setError(null);
    try {
      const res = await fetch("/api/collab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ askId, note }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went sideways. Try again.");
        setPhase("composing");
        return;
      }
      setPhase("sent");
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
      setPhase("composing");
    }
  }

  if (existingStatus === "accepted") {
    return (
      <p className="text-[0.75rem] text-green">
        Accepted. The thread is waiting in your messages.
      </p>
    );
  }
  if (existingStatus === "declined") {
    return (
      <p className="text-[0.75rem] text-ink-faint">
        The poster declined your request on this ask.
      </p>
    );
  }
  if (existingStatus === "pending" || phase === "sent") {
    return <PendingState requestId={requestId} />;
  }

  if (phase === "idle") {
    return (
      <button
        type="button"
        onClick={() => setPhase("composing")}
        className="bt-btn px-3 py-1 text-[0.75rem]"
      >
        I have some of that
      </button>
    );
  }

  return (
    <div className="w-full">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="What you hold, roughly. Skip anything that would identify you."
        className="bt-input font-sans text-[0.8125rem]"
        disabled={phase === "sending"}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={phase === "sending"}
          className="bt-btn bt-btn-primary px-3 py-1 text-[0.75rem]"
        >
          {phase === "sending" ? "Sending..." : "Send collab request"}
        </button>
        <button
          type="button"
          onClick={() => {
            setPhase("idle");
            setError(null);
          }}
          disabled={phase === "sending"}
          className="bt-btn px-3 py-1 text-[0.75rem]"
        >
          Cancel
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}

function PendingState({ requestId }: { requestId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    if (!requestId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/collab/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "withdraw" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not withdraw.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[0.75rem] text-amber">
        Requested. Waiting on the poster.
      </span>
      {requestId ? (
        <button
          type="button"
          onClick={withdraw}
          disabled={busy}
          className="bt-btn px-2 py-0.5 text-[0.6875rem]"
        >
          {busy ? "..." : "Withdraw"}
        </button>
      ) : null}
      {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
    </div>
  );
}
