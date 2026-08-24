"use client";

/**
 * components/ask/deal-people.tsx
 *
 * The confirmed participants of deals behind an ask, each one a door. A
 * closed ask is a finished transaction, not a dead end: whoever supplied
 * it is exactly who a reader wants to talk to. "Message" opens (or reuses)
 * a two-person thread via POST /api/threads/direct.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export type DealPerson = { username: string; deals: number };

export function DealPeople({ askId, people }: { askId: string; people: DealPerson[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(username: string) {
    setBusy(username);
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
      if (!res.ok || !data.threadId) throw new Error(data.error ?? "Could not open a thread.");
      router.push(`/messages/${data.threadId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  if (people.length === 0) return null;

  return (
    <div className="border border-rule bg-panel">
      <div className="flex items-baseline justify-between border-b border-rule px-5 py-3">
        <span className="bt-label">On the deals behind this ask</span>
        <span className="font-mono text-[0.6875rem] text-ink-dim">{people.length}</span>
      </div>
      <ul className="divide-y divide-rule">
        {people.map((p) => (
          <li key={p.username} className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="truncate font-mono text-[0.8125rem] text-ink">@{p.username}</div>
              <div className="text-[0.6875rem] text-ink-dim">
                {p.deals === 1 ? "1 confirmed deal" : `${p.deals} confirmed deals`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => open(p.username)}
              disabled={busy !== null}
              className="bt-btn shrink-0 px-3 py-1.5 text-[0.75rem]"
            >
              {busy === p.username ? "Opening" : "Message"}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <div className="border-t border-rule px-5 py-3 text-[0.75rem] text-ink">{error}</div>
      ) : null}
      <p className="border-t border-rule px-5 py-3 text-[0.6875rem] leading-relaxed text-ink-dim">
        Closed or not, the people stay reachable. Threads are end-to-end encrypted.
      </p>
    </div>
  );
}
