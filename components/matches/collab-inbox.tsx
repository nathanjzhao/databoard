"use client";

/**
 * Incoming collaboration requests on the viewer's asks, with accept and
 * decline. Accepting opens the thread the server just created and jumps
 * straight into it; declining refreshes the list in place.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { timeAgo } from "./format";

export type InboxRequest = {
  id: string;
  askId: string;
  askTitle: string;
  note: string;
  createdAt: number;
  requesterUsername: string;
};

export function CollabInbox({ requests }: { requests: InboxRequest[] }) {
  return (
    <ul className="divide-y divide-rule border border-rule bg-panel">
      {requests.map((r) => (
        <InboxRow key={r.id} request={r} />
      ))}
    </ul>
  );
}

function InboxRow({ request }: { request: InboxRequest }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

  async function respond(action: "accept" | "decline") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/collab/${request.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        threadId?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Something went sideways. Try again.");
        setBusy(null);
        // A 409 means the request moved under us; pull fresh state.
        if (res.status === 409) router.refresh();
        return;
      }
      if (action === "accept" && data.threadId) {
        router.push(`/messages/${encodeURIComponent(data.threadId)}`);
        return;
      }
      setDeclined(true);
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
      setBusy(null);
    }
  }

  if (declined) {
    return (
      <li className="px-5 py-4 text-[0.8125rem] text-ink-faint">
        Declined. @{request.requesterUsername} sees the request as resolved,
        nothing more.
      </li>
    );
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[0.8125rem] text-amber">
          @{request.requesterUsername}
        </span>
        <span className="text-[0.8125rem] text-ink-dim">has supply for</span>
        <span className="text-[0.875rem] text-ink">{request.askTitle}</span>
        <span className="ml-auto bt-label">{timeAgo(request.createdAt)}</span>
      </div>

      {request.note ? (
        <p className="mt-2 max-w-[70ch] border-l-2 border-rule-strong pl-3 text-[0.8125rem] leading-relaxed text-ink-dim">
          {request.note}
        </p>
      ) : (
        <p className="mt-2 text-[0.8125rem] italic text-ink-ghost">
          No note attached.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => respond("accept")}
          disabled={busy !== null}
          className="bt-btn bt-btn-primary px-3 py-1 text-[0.75rem]"
        >
          {busy === "accept" ? "Opening thread..." : "Accept and open a thread"}
        </button>
        <button
          type="button"
          onClick={() => respond("decline")}
          disabled={busy !== null}
          className="bt-btn px-3 py-1 text-[0.75rem]"
        >
          {busy === "decline" ? "..." : "Decline"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </li>
  );
}
