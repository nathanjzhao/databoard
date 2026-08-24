"use client";

/**
 * One thread: header, the participants strip, the standing advice banner,
 * the message log, and the composer. Threads are rooms, not pairs: a deal
 * room seats everyone named on a deal, so every message is labeled with its
 * sender and each participant keeps one color for the whole conversation.
 * Polls /api/threads/:id every few seconds with a `since` cursor and
 * dedupes by message id, so no websockets and no missed same-millisecond
 * writes.
 *
 * Encryption happens HERE, in the client, never on the server. The thread
 * is in exactly one of these states:
 *
 *   ready       keys are installed and this tab holds the private key:
 *               bodies decrypt in place, sends are sealed before they
 *               leave the browser.
 *   setup       the thread has no keys yet and every seat has a registered
 *               public key: this client (the first to open it) generates
 *               the thread key, wraps it for every seat, and installs it.
 *               A concurrent setup by another seat wins gracefully.
 *   locked      keys exist but this tab has no private key (fresh tab):
 *               ciphertext shows as placeholders until the user unlocks
 *               with their password, verified against their registered
 *               public key. Nothing typed here is sent anywhere.
 *   plaintext   at least one seat has no encryption key (an account from
 *               before E2EE that has not signed in since), so the thread
 *               honestly stays unencrypted and wears a visible tag.
 *   key_error   keys exist but the viewer's wrap will not open with this
 *               password-derived key. Loud, not silent: it means the
 *               registered public key and the derived one disagree.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_MESSAGE_LENGTH,
  type ThreadDetail,
  type ThreadEncryption,
  type WireMessage,
} from "./types";
import { senderColorClass, stamp } from "./format";
import { DealRoomTag } from "./deal-room-tag";
import { loadKeys, unlockWithPassword, type UnlockedKeys } from "./keystore";
import {
  generateThreadKey,
  isEnvelope,
  openMessage,
  sealMessage,
  unwrapThreadKey,
  wrapThreadKey,
} from "@/lib/e2ee";
import { RecordDealFromThread } from "@/components/deals/record-deal-link";

const POLL_MS = 3000;

/**
 * The quick-insert for the banner button. Dropped into the composer for the
 * sender to edit, never auto-sent, and it leaves through the same encrypt
 * path as anything else typed there.
 */
const MEETUP_TEMPLATE = [
  "Suggesting we take the specifics off-platform. I can do a call, or meet",
  "in person if we share a city. Name a time window and a place or channel",
  "that works, and we keep samples and exact figures for the meeting.",
].join(" ");

const DECRYPT_PLACEHOLDER = "Encrypted message";
const DECRYPT_FAILED = "Could not decrypt this message on this device.";

type EncMode = "ready" | "setup" | "locked" | "plaintext" | "key_error";

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

function everySeatHasKey(enc: ThreadEncryption): boolean {
  return enc.participants.length > 0 && enc.participants.every((p) => p.pubkey !== null);
}

export function ThreadView({
  initial,
  viewer,
}: {
  initial: ThreadDetail;
  viewer: string;
}) {
  const [messages, setMessages] = useState<WireMessage[]>(initial.messages);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [enc, setEnc] = useState<ThreadEncryption>(initial.encryption);
  const [keys, setKeys] = useState<UnlockedKeys | null>(null);
  const [keysProbed, setKeysProbed] = useState(false);
  const [threadKey, setThreadKey] = useState<Uint8Array | null>(null);
  const [keyError, setKeyError] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [plaintextById, setPlaintextById] = useState<Record<string, string | null>>({});

  const logRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true); // is the viewer scrolled to the bottom?
  const sinceRef = useRef(highWater(initial.messages));
  const setupOnceRef = useRef(false);

  /* --------------------------------------------------- encryption state */

  // Probe sessionStorage once, on the client only.
  useEffect(() => {
    setKeys(loadKeys(viewer));
    setKeysProbed(true);
  }, [viewer]);

  const mode: EncMode = keyError
    ? "key_error"
    : enc.keysExist
      ? threadKey
        ? "ready"
        : keys || !keysProbed
          ? "setup" // unwrapping in flight
          : "locked"
      : everySeatHasKey(enc)
        ? threadKey
          ? "ready"
          : keys || !keysProbed
            ? "setup"
            : "locked"
        : "plaintext";

  // Unwrap the viewer's copy of the thread key once keys are in hand.
  useEffect(() => {
    if (!keys || threadKey || !enc.keysExist) return;
    let cancelled = false;
    (async () => {
      if (!enc.myWrappedKey || !enc.myEphPubkey) {
        if (!cancelled) setKeyError(true);
        return;
      }
      const tk = await unwrapThreadKey(
        enc.myWrappedKey,
        enc.myEphPubkey,
        keys.secretKey,
        initial.id,
      );
      if (cancelled) return;
      if (tk) setThreadKey(tk);
      else setKeyError(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [keys, threadKey, enc, initial.id]);

  // First client to open a keyless, fully-keyed thread sets encryption up.
  useEffect(() => {
    if (enc.keysExist || !keys || !everySeatHasKey(enc)) return;
    if (setupOnceRef.current) return;
    setupOnceRef.current = true;
    let cancelled = false;
    (async () => {
      setSettingUp(true);
      try {
        const tk = generateThreadKey();
        const wraps: { username: string; wrappedKey: string; ephPubkey: string }[] = [];
        for (const p of enc.participants) {
          const wrapped = await wrapThreadKey(tk, p.pubkey!, initial.id);
          if (!wrapped) throw new Error("wrap failed");
          wraps.push({ username: p.username, ...wrapped });
        }
        const res = await fetch(`/api/threads/${initial.id}/keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keys: wraps }),
        });
        if (cancelled) return;
        if (res.ok) {
          setThreadKey(tk);
          setEnc((prev) => ({ ...prev, keysExist: true }));
          return;
        }
        // 409: another seat won the race. Refetch and unwrap their key.
        const fresh = await fetch(`/api/threads/${initial.id}?since=0`, {
          cache: "no-store",
        });
        if (!fresh.ok || cancelled) return;
        const data = (await fresh.json()) as { thread: ThreadDetail };
        if (data.thread?.encryption) setEnc(data.thread.encryption);
      } catch {
        // Transient failure; allow a retry on the next mount of this thread.
        setupOnceRef.current = false;
      } finally {
        if (!cancelled) setSettingUp(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enc, keys, initial.id]);

  // Decrypt whatever envelopes the cache does not cover yet.
  useEffect(() => {
    if (!threadKey) return;
    const pending = messages.filter(
      (m) => isEnvelope(m.body) && plaintextById[m.id] === undefined,
    );
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      const additions: Record<string, string | null> = {};
      for (const m of pending) {
        additions[m.id] = await openMessage(threadKey, initial.id, m.body);
      }
      if (!cancelled) setPlaintextById((prev) => ({ ...prev, ...additions }));
    })();
    return () => {
      cancelled = true;
    };
  }, [threadKey, messages, plaintextById, initial.id]);

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
        if (stopped || !data.thread) return;
        // Another seat may have installed keys since the page rendered.
        if (data.thread.encryption?.keysExist) {
          setEnc((prev) => (prev.keysExist ? prev : data.thread.encryption));
        }
        const incoming = data.thread.messages;
        if (!Array.isArray(incoming) || incoming.length === 0) return;
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

  const canSend = mode === "ready" || mode === "plaintext";

  async function send() {
    const body = draft.trim();
    if (!body || sending || !canSend) return;
    setSending(true);
    setSendError(null);
    try {
      const outgoing =
        mode === "ready" && threadKey
          ? await sealMessage(threadKey, initial.id, body)
          : body;
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: initial.id, body: outgoing }),
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
      // Cache the plaintext we just sealed so our own message renders
      // instantly instead of taking a decrypt round.
      if (isEnvelope(sent.body)) {
        setPlaintextById((prev) => ({ ...prev, [sent.id]: body }));
      }
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
  const encrypted = mode === "ready" || mode === "setup" || mode === "locked" || mode === "key_error";

  function renderBody(m: WireMessage): { text: string; kind: "plain" | "legacy" | "cipher" } {
    if (!isEnvelope(m.body)) {
      // Plaintext row. In an encrypted thread that makes it a legacy row
      // (written before keys existed), worth its own honest label.
      return { text: m.body, kind: enc.keysExist ? "legacy" : "plain" };
    }
    const cached = plaintextById[m.id];
    if (cached === undefined) return { text: DECRYPT_PLACEHOLDER, kind: "cipher" };
    if (cached === null) return { text: DECRYPT_FAILED, kind: "cipher" };
    return { text: cached, kind: "plain" };
  }

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
          {encrypted ? (
            <span
              className="inline-block shrink-0 border border-rule-strong bg-panel px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-ink-dim"
              title="Messages are sealed in the sender's browser; the server stores ciphertext"
            >
              end-to-end encrypted
            </span>
          ) : (
            <span
              className="inline-block shrink-0 border border-red/40 bg-red-wash px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-red"
              title="A participant has no encryption key, so this thread is stored in the clear"
            >
              not end-to-end encrypted
            </span>
          )}
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
            {encrypted
              ? "Messages here are end-to-end encrypted: they are sealed in your browser and the operator stores ciphertext it cannot read. Even so, establish interest here and close elsewhere. Sensitive details and data samples should move off-platform, and the strongest deals get closed face to face."
              : "This thread is not end-to-end encrypted, so write accordingly. Establish interest here, close elsewhere. Sensitive details and data samples should move off-platform, and the strongest deals get closed face to face."}
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

      {/* unlock panel: a fresh tab has no private key until the password re-derives it */}
      {mode === "locked" ? (
        <UnlockPanel
          viewer={viewer}
          expectedPubkey={
            enc.participants.find((p) => p.username === viewer)?.pubkey ?? null
          }
          onUnlocked={(k) => {
            setKeys(k);
            setKeyError(false);
          }}
        />
      ) : null}

      {mode === "key_error" ? (
        <div className="mt-5 border-l-2 border-red bg-red-wash px-4 py-3">
          <div className="bt-label text-red">Key mismatch</div>
          <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-dim">
            The key derived from your password cannot open this thread. That
            should never happen quietly, so we are saying it loudly: the
            encryption key registered for your account does not match the one
            your password produces. Sign out and back in; if this persists,
            do not treat this thread as private.
          </p>
        </div>
      ) : null}

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
            {messages.map((m) => {
              const rendered = renderBody(m);
              return (
                <li key={m.id} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="flex items-baseline gap-2">
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
                      {rendered.kind === "legacy" ? (
                        <span
                          className="font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-ink-ghost"
                          title="Written before this thread had encryption keys; stored in the clear"
                        >
                          sent unencrypted
                        </span>
                      ) : null}
                    </span>
                    <span
                      suppressHydrationWarning
                      className="shrink-0 font-mono text-[0.625rem] text-ink-ghost"
                    >
                      {stamp(m.createdAt)}
                    </span>
                  </div>
                  <p
                    className={[
                      "mt-1 text-[0.875rem] leading-relaxed break-words whitespace-pre-wrap",
                      rendered.kind === "cipher" ? "text-ink-faint italic" : "text-ink",
                    ].join(" ")}
                  >
                    {rendered.text}
                  </p>
                </li>
              );
            })}
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
            {encrypted ? (
              <>
                End-to-end encrypted. The server stores ciphertext, tied to a
                username and nothing else.{" "}
                <Link href="/transparency" className="text-blue hover:text-amber">
                  The schema says so.
                </Link>
              </>
            ) : (
              <>
                Not end-to-end encrypted: a participant here has no encryption
                key yet. Stored in the clear, tied to a username and nothing
                else.{" "}
                <Link href="/transparency" className="text-blue hover:text-amber">
                  The schema says so.
                </Link>
              </>
            )}
          </p>
          <div className="flex items-center gap-3">
            {mode === "setup" ? (
              <span className="font-mono text-[0.6875rem] text-ink-faint">
                {settingUp ? "setting up encryption" : "preparing keys"}
              </span>
            ) : null}
            {mode === "locked" ? (
              <span className="font-mono text-[0.6875rem] text-ink-faint">
                unlock to send
              </span>
            ) : null}
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
              disabled={sending || !canSend || draft.trim().length === 0}
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

/**
 * The password prompt for a tab that holds no private key. The password
 * goes into scrypt locally and nowhere else; the derived public key must
 * match the one registered for the account before anything is stored.
 */
function UnlockPanel({
  viewer,
  expectedPubkey,
  onUnlocked,
}: {
  viewer: string;
  expectedPubkey: string | null;
  onUnlocked: (keys: UnlockedKeys) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      if (!expectedPubkey) {
        setError("No encryption key is registered yet. Sign out and back in to set one up.");
        return;
      }
      const keys = await unlockWithPassword(viewer, password, expectedPubkey);
      if (!keys) {
        setError("That password does not produce this account's key.");
        return;
      }
      setPassword("");
      onUnlocked(keys);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 border border-rule bg-panel px-4 py-3">
      <div className="bt-label">Unlock this thread</div>
      <p className="mt-1.5 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        Messages here are encrypted and this tab does not hold your key yet.
        Your password re-derives it locally; it is checked against your
        registered public key and never leaves the browser.
      </p>
      <form onSubmit={unlock} className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Account password"
          className="bt-input max-w-[16rem] font-mono"
          aria-label="Account password"
        />
        <button
          type="submit"
          disabled={busy || !password}
          className="bt-btn text-[0.8125rem]"
        >
          {busy ? "Deriving" : "Unlock"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </form>
    </div>
  );
}
