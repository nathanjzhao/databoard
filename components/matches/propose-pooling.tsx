"use client";

/**
 * components/matches/propose-pooling.tsx
 *
 * The door between two suppliers offering into the same ask. "Propose
 * pooling" opens (or reuses) a two-person thread via POST /api/threads/direct;
 * the server checks that both sides hold a live collab request on the ask, so
 * this button cannot reach anyone the ask does not vouch for.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ProposePooling({
  askId,
  username,
}: {
  askId: string;
  username: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/threads/direct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ askId, username }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        threadId?: string;
        error?: string;
      };
      if (!res.ok || !data.threadId) {
        throw new Error(data.error ?? "Could not open a thread.");
      }
      router.push(`/messages/${encodeURIComponent(data.threadId)}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className="bt-btn shrink-0 px-3 py-1 text-[0.75rem]"
      >
        {busy ? "Opening" : "Propose pooling"}
      </button>
      {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
    </span>
  );
}
