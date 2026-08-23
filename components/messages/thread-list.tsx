"use client";

/**
 * The /messages inbox. Server-rendered with real rows, then kept fresh with
 * a light poll: no websockets, just a fetch every few seconds while the tab
 * is visible. The unread dot is per-viewer state (thread_participants.
 * last_read_at) and nothing else; the other side never sees a receipt.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ThreadSummary } from "./types";
import { participantsLine, relTime } from "./format";
import { DealRoomTag } from "./deal-room-tag";

const POLL_MS = 5000;

export function ThreadList({ initial }: { initial: ThreadSummary[] }) {
  const [threads, setThreads] = useState<ThreadSummary[]>(initial);

  useEffect(() => {
    let stopped = false;
    async function tick() {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/threads", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { threads: ThreadSummary[] };
        if (!stopped && Array.isArray(data.threads)) setThreads(data.threads);
      } catch {
        // Transient network hiccup; the next tick will try again.
      }
    }
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (threads.length === 0) return <EmptyState />;

  return (
    <div className="bt-panel divide-y divide-rule">
      {threads.map((t) => (
        <ThreadRow key={t.id} thread={t} />
      ))}
    </div>
  );
}

function ThreadRow({ thread: t }: { thread: ThreadSummary }) {
  const title = t.subject || t.askTitle || "Untitled thread";
  const showRe = Boolean(t.askTitle && t.askTitle !== t.subject && t.subject);
  const withLine = participantsLine(t.others);

  return (
    <Link
      href={`/messages/${t.id}`}
      className="group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-panel-2"
    >
      <span
        aria-label={t.unread ? "Unread" : undefined}
        className={[
          "mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full",
          t.unread ? "bg-amber" : "bg-transparent",
        ].join(" ")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="max-w-full truncate font-mono text-[0.75rem] text-ink-dim">
            {withLine}
          </span>
          {t.dealId ? <DealRoomTag /> : null}
          {showRe ? (
            <span className="bt-label truncate">re: {t.askTitle}</span>
          ) : null}
        </span>
        <span
          className={[
            "mt-1 block truncate text-[0.9375rem]",
            t.unread ? "font-medium text-ink" : "text-ink-dim",
          ].join(" ")}
        >
          {title}
        </span>
        <span className="mt-0.5 block truncate text-[0.8125rem] text-ink-faint">
          {t.lastBody ? (
            <>
              {t.lastSender ? (
                <span className="font-mono text-[0.75rem]">@{t.lastSender}: </span>
              ) : null}
              {t.lastBody}
            </>
          ) : (
            "No messages yet. Someone has to go first."
          )}
        </span>
      </span>
      <span
        suppressHydrationWarning
        className="shrink-0 pt-0.5 font-mono text-[0.6875rem] text-ink-ghost"
      >
        {relTime(t.lastAt)}
      </span>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="bt-panel px-6 py-14 text-center">
      <div className="bt-label">No threads yet</div>
      <p className="mx-auto mt-3 max-w-[46ch] text-[0.875rem] leading-relaxed text-ink-faint">
        A thread opens when a collab request is accepted, or when a recorded
        deal names participants and gets its deal room. Until then nobody can
        cold-message anybody, which is how it should be.
      </p>
      <Link href="/matches" className="bt-btn mt-6 text-[0.8125rem]">
        See your matches
      </Link>
    </div>
  );
}
