"use client";

/**
 * components/ask/collab-button.tsx
 *
 * "I have some of that." One optional note, one button, one row in
 * collab_requests, via POST /api/collab (the same endpoint the matches page
 * uses). The server enforces one request per person per ask, so after a
 * success (or a 409 saying it already exists) the panel settles into a sent
 * state. Threads happen elsewhere.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

type ExistingStatus = "pending" | "accepted" | "declined" | "withdrawn";

const SENT_COPY: Record<ExistingStatus, string> = {
  pending:
    "Request sent. The poster sees your username and your note, nothing else.",
  accepted: "Accepted. Take it to Messages.",
  declined: "Declined. That is the whole story; there is no appeal flow.",
  withdrawn: "You withdrew this request.",
};

export function CollabPanel({
  askId,
  existingStatus,
}: {
  askId: string;
  existingStatus: ExistingStatus | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<ExistingStatus | null>(existingStatus);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/collab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ askId, note: note.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        // A request that already exists is a settled state, not an error.
        if (data.code === "already_requested") {
          setSent("pending");
          router.refresh();
          return;
        }
        if (data.code === "already_accepted") {
          setSent("accepted");
          router.refresh();
          return;
        }
        throw new Error(data.error ?? "Request failed.");
      }
      setSent("pending");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="border border-green/30 bg-green-wash px-5 py-4">
        <div className="bt-label text-green">
          {sent === "pending" ? "Request sent" : `Request ${sent}`}
        </div>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-dim">
          {SENT_COPY[sent]}
        </p>
      </div>
    );
  }

  return (
    <div className="border border-rule bg-panel">
      <div className="border-b border-rule px-5 py-3">
        <span className="bt-label">Have some of this?</span>
      </div>
      <div className="px-5 py-4">
        <label className="block">
          <span className="bt-label">Note to the poster, optional</span>
          <textarea
            className="bt-input mt-2 min-h-[5.5rem] resize-y leading-relaxed"
            maxLength={2000}
            placeholder="What you hold, roughly how much of the ask it covers. Skip anything that identifies you; that is what the note is for once you both agree."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="bt-btn bt-btn-primary px-5 py-2"
          >
            {busy ? "Sending" : "Request to collaborate"}
          </button>
          <span className="text-[0.75rem] text-ink-faint">
            One request per ask. The poster sees your username and this note.
          </span>
        </div>
        {error ? (
          <div className="mt-3 border-l-2 border-red bg-red-wash px-4 py-2.5 text-[0.75rem] text-ink">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
