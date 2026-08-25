"use client";

/**
 * components/ask/mandate-commit.tsx
 *
 * Mandate commitments on asks, browser side. Same construction as the deals
 * evidence widget (components/deals/evidence-commit.tsx): the poster picks
 * the mandate document (an RFP, an MSA, a buyer email thread export), the
 * browser hashes it with WebCrypto SHA-256, and only the 64-hex fingerprint
 * plus a short label ever leave the machine. There is no upload path for the
 * document to take.
 *
 * Three faces, one rule:
 *   MandatePin     the optional section in the compose form; hands the
 *                  finished {docHash, label} up to the form, which sends it
 *                  with the ask so both share one timestamp.
 *   MandateCommit  the owner's add-later panel on the ask page; POSTs to
 *                  /api/asks/[id]/mandate and wears today's date, next to
 *                  the posting date, so a late pin is visibly late.
 *   MandateBlock   what everyone sees once a mandate exists: hash, label,
 *                  and the committed/posted honesty line.
 *
 * The word "verified" appears nowhere in this file on purpose. A hash pins
 * the poster to one document; it does not make the document genuine.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { timeAgo } from "@/components/ask/format";

const MAX_LABEL = 80;

/** First 12 hex characters, matching the deals evidence convention. */
function mandateHashShort(hash: string): string {
  return hash.slice(0, 12);
}

async function sha256HexOf(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------ shared bits */

function HashReadout({ fileName, hash }: { fileName: string | null; hash: string }) {
  return (
    <div className="border border-rule bg-panel-2 px-3 py-2.5">
      <div className="bt-label">SHA-256 of {fileName ?? "the file"}</div>
      <div className="mt-1 break-all font-mono text-[0.6875rem] leading-relaxed text-ink">
        {hash}
      </div>
    </div>
  );
}

/* ------------------------------------------------- compose form: the pin */

export type MandatePinState =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "ready"; docHash: string; label: string };

/**
 * The optional "Pin a mandate document" body for the compose form. Owns the
 * file/hash/label state and reports upward: "none" (nothing picked),
 * "incomplete" (hashed but unlabeled; the form blocks posting rather than
 * silently dropping the pin), or "ready" with the payload the form sends.
 */
export function MandatePin({
  onChange,
}: {
  onChange: (state: MandatePinState) => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [hashing, setHashing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function report(nextHash: string | null, nextLabel: string) {
    if (!nextHash) return onChange({ kind: "none" });
    const trimmed = nextLabel.trim();
    if (trimmed.length === 0) return onChange({ kind: "incomplete" });
    onChange({ kind: "ready", docHash: nextHash, label: trimmed });
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setHashing(true);
    setError(null);
    setHash(null);
    setFileName(file.name);
    onChange({ kind: "incomplete" });
    try {
      const hex = await sha256HexOf(file);
      setHash(hex);
      report(hex, label);
    } catch {
      setError("Could not hash that file in this browser.");
      setFileName(null);
      onChange({ kind: "none" });
    } finally {
      setHashing(false);
    }
  }

  function clear() {
    setFileName(null);
    setHash(null);
    setLabel("");
    setError(null);
    onChange({ kind: "none" });
  }

  return (
    <div className="space-y-3">
      <p className="max-w-[62ch] text-[0.75rem] leading-relaxed text-ink-faint">
        Optional. Pick the document this ask answers to: the RFP, the MSA,
        the buyer email thread. Your browser computes its SHA-256 locally;
        the file never leaves this machine and there is nowhere on the server
        for it to land. The hash pins you to this one document before anyone
        engages. It proves consistency, not authenticity: anyone later shown
        a different document can catch the mismatch, and nobody can check
        the document is genuine from the hash alone.
      </p>
      <p className="max-w-[62ch] text-[0.75rem] text-ink-faint">
        Write-once. A committed hash cannot be replaced, so check the file
        first.
      </p>

      <label className="block">
        <span className="bt-label">Mandate document</span>
        <input
          type="file"
          onChange={onPick}
          disabled={hashing}
          className="mt-2 block w-full text-[0.8125rem] text-ink-dim file:mr-3 file:cursor-pointer file:border file:border-rule-strong file:bg-panel-2 file:px-3 file:py-1.5 file:text-[0.75rem] file:text-ink"
        />
      </label>

      {hashing ? (
        <p className="font-mono text-[0.75rem] text-ink-faint">hashing locally…</p>
      ) : null}
      {error ? <p className="text-[0.75rem] text-red">{error}</p> : null}

      {hash ? (
        <>
          <HashReadout fileName={fileName} hash={hash} />
          <label className="block">
            <span className="bt-label">Label</span>
            <input
              className="bt-input mt-2"
              maxLength={MAX_LABEL}
              placeholder="Buyer RFP, rev 3, PDF"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                report(hash, e.target.value);
              }}
            />
            <span className="mt-1.5 block text-[0.6875rem] text-ink-faint">
              A few words saying what the original is. Stored next to the
              hash.
            </span>
          </label>
          {label.trim().length === 0 ? (
            <p className="border-l-2 border-amber pl-3 text-[0.75rem] text-amber">
              Label it or clear it. An unlabeled pin does not post.
            </p>
          ) : null}
          <button
            type="button"
            onClick={clear}
            className="text-[0.75rem] text-ink-faint hover:text-ink-dim"
          >
            clear the pin
          </button>
        </>
      ) : null}
    </div>
  );
}

/* -------------------------------------------- ask page: owner, add later */

type CommitPhase = "idle" | "hashing" | "ready" | "sending" | "done";

/**
 * The add-later panel. Only rendered to the owner of an ask that has no
 * mandate yet. Same hashing, one difference the copy owns: the commitment
 * is stamped today, next to the posting date, so pinning late is visible.
 */
export function MandateCommit({ askId }: { askId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<CommitPhase>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhase("hashing");
    setError(null);
    setHash(null);
    setFileName(file.name);
    try {
      const hex = await sha256HexOf(file);
      setHash(hex);
      setPhase("ready");
    } catch {
      setError("Could not hash that file in this browser.");
      setPhase("idle");
    }
  }

  async function commit() {
    if (!hash || label.trim().length === 0) return;
    setPhase("sending");
    setError(null);
    try {
      const res = await fetch(`/api/asks/${encodeURIComponent(askId)}/mandate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docHash: hash, label: label.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went sideways. Try again.");
        setPhase("ready");
        return;
      }
      setPhase("done");
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
      setPhase("ready");
    }
  }

  if (phase === "done") {
    return (
      <div className="border border-rule bg-panel px-5 py-4">
        <p className="text-[0.8125rem] text-green">
          Committed. The fingerprint is on the ask; keep the original file.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-rule bg-panel">
      <div className="border-b border-rule px-5 py-3">
        <span className="bt-label">Pin a mandate document</span>
      </div>
      <div className="px-5 py-4">
        <p className="max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-dim">
          Commit the SHA-256 of the document this ask answers to: the RFP,
          the MSA, the buyer email thread. Hashed in this browser; the file
          never leaves this machine. The hash proves consistency, not
          authenticity: it pins you to one document, and anyone later shown
          a different one has receipts.
        </p>
        <p className="mt-2 text-[0.75rem] text-ink-faint">
          Write-once, and stamped today: the commitment date is shown next to
          the posting date, so a late pin reads as a late pin. Check the file
          before committing.
        </p>

        <div className="mt-3.5 space-y-3">
          <label className="block">
            <span className="bt-label">Document</span>
            <input
              type="file"
              onChange={onPick}
              disabled={phase === "hashing" || phase === "sending"}
              className="mt-2 block w-full text-[0.8125rem] text-ink-dim file:mr-3 file:cursor-pointer file:border file:border-rule-strong file:bg-panel-2 file:px-3 file:py-1.5 file:text-[0.75rem] file:text-ink"
            />
          </label>

          {phase === "hashing" ? (
            <p className="font-mono text-[0.75rem] text-ink-faint">
              hashing locally…
            </p>
          ) : null}

          {hash ? <HashReadout fileName={fileName} hash={hash} /> : null}

          {hash ? (
            <label className="block">
              <span className="bt-label">Label</span>
              <input
                className="bt-input mt-2"
                maxLength={MAX_LABEL}
                placeholder="Buyer RFP, rev 3, PDF"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={phase === "sending"}
              />
              <span className="mt-1.5 block text-[0.6875rem] text-ink-faint">
                A few words saying what the original is. Stored next to the
                hash.
              </span>
            </label>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={commit}
              disabled={!hash || label.trim().length === 0 || phase === "sending"}
              className="bt-btn px-4 py-1.5 text-[0.75rem]"
            >
              {phase === "sending"
                ? "Committing…"
                : hash
                  ? `Commit ${mandateHashShort(hash)}…`
                  : "Pick a file first"}
            </button>
            {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------- ask page: the record */

/**
 * The committed mandate, shown to everyone. Truncated hash (full on click,
 * and in the title attribute), the poster's label, and the honesty line:
 * committed when, posted when, side by side, so a late commitment is
 * visibly late.
 */
export function MandateBlock({
  docHash,
  label,
  committedAt,
  postedAt,
  nowMs,
}: {
  docHash: string;
  label: string;
  committedAt: number;
  postedAt: number;
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const withPost = committedAt - postedAt < 60_000;

  return (
    <div className="border border-rule bg-panel">
      <div className="border-b border-rule px-5 py-3">
        <span className="bt-label">Mandate committed</span>
      </div>
      <div className="px-5 py-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={docHash}
          className={[
            "block w-full text-left font-mono text-[0.6875rem] leading-relaxed text-ink transition-colors hover:text-ink-dim",
            expanded ? "break-all" : "",
          ].join(" ")}
          aria-label={expanded ? "Collapse the mandate hash" : "Show the full mandate hash"}
        >
          {expanded ? docHash : `${mandateHashShort(docHash)}…`}
        </button>
        {label ? (
          <p className="mt-2 text-[0.8125rem] leading-snug text-ink-dim">{label}</p>
        ) : null}
        <p className="mt-3 font-mono text-[0.6875rem] text-ink-faint">
          {withPost
            ? `committed with the post, ${timeAgo(postedAt, nowMs)}`
            : `committed ${timeAgo(committedAt, nowMs)}, posted ${timeAgo(postedAt, nowMs)}`}
        </p>
        <p className="mt-3 text-[0.75rem] leading-relaxed text-ink-faint">
          The SHA-256 of a document the poster pinned this ask to, hashed in
          their browser; the document itself never reached the server. It
          proves consistency, not authenticity: shown the original, anyone
          can recompute the hash and check it against this record.{" "}
          <Link
            href="/transparency/verification#asks"
            className="text-blue hover:text-amber"
          >
            What that is worth
          </Link>
        </p>
      </div>
    </div>
  );
}
