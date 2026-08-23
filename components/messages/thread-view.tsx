"use client";

/**
 * One thread: header, the participants strip, the standing off-platform
 * advice banner, the message log, and the composer. Threads are rooms, not
 * pairs: a deal room seats everyone named on a deal, so every message is
 * labeled with its sender and each participant keeps one color for the whole
 * conversation. Polls /api/threads/:id every few seconds with a `since`
 * cursor and dedupes by message id, so no websockets and no missed
 * same-millisecond writes.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_MESSAGE_LENGTH,
  type ThreadDetail,
  type WireMessage,
} from "./types";
import { senderColorClass, stamp } from "./format";
import { DealRoomTag } from "./deal-room-tag";
import { RecordDealFromThread } from "@/components/deals/record-deal-link";

const POLL_MS = 3000;

/**
 * The quick-insert for the banner button. Dropped into the composer for the
 * sender to edit, never auto-sent.
 */
const MEETUP_TEMPLATE = [
  "Suggesting we take the specifics off-platform. I can do a call, or meet",
  "in person if we share a city. Name a time window and a place or channel",
  "that works, and we keep samples and exact figures for the meeting.",
].join(" ");

function mergeMessages(prev: WireMessage[], incoming: WireMessage[]): WireMessage[] {
  if (incoming.length === 0) return prev;
  const byId = new Map<string, WireMessage>();
  for (const m of prev) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function highWater(messages: WireMessage[]): number {
  let max = 0;
  for (const m of messages) if (m.createdAt > max) max = m.createdAt;
  return max;
}

export function ThreadView({ initial }: { initial: ThreadDetail }) {
  const [messages, setMessages] = useState<WireMessage[]>(initial.messages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true); // is the viewer scrolled to the bottom?
  const sinceRef = useRef(highWater(initial.messages));

  /* ------------------------------------------------------------- polling */

  useEffect(() => {
    let stopped = false;
    async function tick() {
      if (document.hidden) return;
      try {
        const res = await fetch(
          `/api/threads/${initial.id}?since=${sinceRef.current}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { thread: ThreadDetail };
        const incoming = data.thread?.messages;
        if (stopped || !Array.isArray(incoming) || incoming.length === 0) return;
        setMessages((prev) => {
          const next = mergeMessages(prev, incoming);
          sinceRef.current = highWater(next);
          return next;
        });
      } catch {
        // Transient failure; next tick retries.
      }
    }
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [initial.id]);

  /* -------------------------------------------------------- auto-scroll */

  useEffect(() => {
    const log = logRef.current;
    if (log && pinnedRef.current) log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  const onLogScroll = useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    pinnedRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }, []);

  /* ------------------------------------------------------------- sending */

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: initial.id, body }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: WireMessage;
        error?: string;
      };
      if (!res.ok || !data.message) {
        setSendError(data.error ?? "Could not send. Try again.");
        return;
      }
      const sent = data.message;
      pinnedRef.current = true;
      setMessages((prev) => {
        const next = mergeMessages(prev, [sent]);
        sinceRef.current = highWater(next);
        return next;
      });
      setDraft("");
    } catch {
      setSendError("Could not send. Try again.");
    } finally {
      setSending(false);
    }
  }

  function insertMeetupTemplate() {
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${MEETUP_TEMPLATE}` : MEETUP_TEMPLATE));
    textRef.current?.focus();
  }

  /* ------------------------------------------------------------- render */

  const title = initial.subject || initial.askTitle || "Thread";
  const seatCount = initial.others.length + 1;

  return (
    <div>
      {/* header */}
      <div className="border-b border-rule-strong pb-5">
        <Link
          href="/messages"
          className="bt-label text-ink-faint transition-colors hover:text-amber"
        >
          &larr; All threads
        </Link>
        <h1 className="bt-display mt-3 text-[1.85rem] leading-[1.1] text-ink">
          {title}
        </h1>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="font-mono text-[0.75rem] text-ink-dim">
            {seatCount === 1 ? "1 seat" : `${seatCount} seats`}
          </span>
          {initial.dealId ? <DealRoomTag /> : null}
          {initial.askTitle && initial.askTitle !== initial.subject ? (
            <span className="bt-label">re: {initial.askTitle}</span>
          ) : null}
        </div>
      </div>

      {/* participants strip: who is at the table, and what the table is for */}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border border-rule bg-panel px-4 py-2.5">
        <span className="bt-label">At the table</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[0.75rem] text-amber">you</span>
          {initial.others.map((u) => (
            <span
              key={u}
              className={[
                "font-mono text-[0.75rem]",
                senderColorClass(u, initial.others),
              ].join(" ")}
            >
              @{u}
            </span>
          ))}
          {initial.others.length === 0 ? (
            <span className="font-mono text-[0.75rem] text-ink-ghost">
              nobody else, they left the table
            </span>
          ) : null}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {initial.dealId ? (
            <Link
              href={`/deals/${initial.dealId}`}
              className="text-[0.75rem] text-blue transition-colors hover:text-amber"
            >
              Full deal record
            </Link>
          ) : null}
          <RecordDealFromThread threadId={initial.id} />
        </span>
      </div>

      {/* the standing advice banner, present in every thread */}
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-l-2 border-amber bg-amber-wash px-4 py-3">
        <div className="min-w-[14rem] flex-1">
          <div className="bt-label text-amber">Standing advice</div>
          <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-dim">
            Establish interest here, close elsewhere. Sensitive details and
            data samples should move off-platform, and the strongest deals get
            closed face to face.
          </p>
        </div>
        <button
          type="button"
          onClick={insertMeetupTemplate}
          className="bt-btn shrink-0 text-[0.75rem]"
        >
          Suggest a meetup
        </button>
      </div>

      {/* message log */}
      <div
        ref={logRef}
        onScroll={onLogScroll}
        className="bt-panel mt-5 max-h-[52vh] min-h-[280px] overflow-y-auto"
      >
        {messages.length === 0 ? (
          <p className="px-5 py-16 text-center text-[0.8125rem] text-ink-faint">
            Nothing said yet. Someone has to go first.
          </p>
        ) : (
          <ol className="divide-y divide-rule">
            {messages.map((m) => (
              <li key={m.id} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={[
                      "font-mono text-[0.6875rem]",
                      m.mine
                        ? "text-amber"
                        : senderColorClass(m.sender, initial.others),
                    ].join(" ")}
                  >
                    @{m.sender}
                  </span>
                  <span
                    suppressHydrationWarning
                    className="shrink-0 font-mono text-[0.625rem] text-ink-ghost"
                  >
                    {stamp(m.createdAt)}
                  </span>
                </div>
                <p className="mt-1 text-[0.875rem] leading-relaxed break-words whitespace-pre-wrap text-ink">
                  {m.body}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* composer */}
      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={textRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="Plain text. Enter sends, Shift+Enter for a new line."
          className="bt-input resize-y font-sans"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.6875rem] text-ink-ghost">
            Stored in the clear on the server, tied to a username and nothing
            else.{" "}
            <Link href="/transparency" className="text-blue hover:text-amber">
              The schema says so.
            </Link>
          </p>
          <div className="flex items-center gap-3">
            {sendError ? (
              <span className="text-[0.75rem] text-red">{sendError}</span>
            ) : null}
            {draft.length > MAX_MESSAGE_LENGTH - 200 ? (
              <span className="font-mono text-[0.6875rem] text-ink-faint">
                {draft.length}/{MAX_MESSAGE_LENGTH}
              </span>
            ) : null}
            <button
              type="submit"
              disabled={sending || draft.trim().length === 0}
              className="bt-btn bt-btn-primary text-[0.8125rem]"
            >
              {sending ? "Sending" : "Send"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
