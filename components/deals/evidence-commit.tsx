"use client";

/**
 * components/deals/evidence-commit.tsx
 *
 * The evidence commitment widget. The participant picks a file (a bank
 * statement line export, a signed receipt email, whatever official thing they
 * hold), the browser hashes it with WebCrypto SHA-256, and only the 64-hex
 * fingerprint plus a short label go to the server. The file itself never
 * leaves the machine; there is no upload path for it to take.
 *
 * The hash is immutable once committed, so the copy tells people to check
 * the file before they commit, and the button says exactly what will be
 * stored before it stores it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { hashShort } from "@/components/deals/format";

type Phase = "idle" | "hashing" | "ready" | "sending" | "done";

const MAX_LABEL = 80;

export function EvidenceCommit({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
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
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
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
      const res = await fetch(`/api/deals/${encodeURIComponent(dealId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "evidence", hash, label: label.trim() }),
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
      <p className="text-[0.8125rem] text-green">
        Committed. The fingerprint is on your row; keep the original file.
      </p>
    );
  }

  return (
    <div className="border border-rule bg-panel px-4 py-4">
      <div className="bt-label">Commit evidence</div>
      <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        Pick the official document that backs your share: a bank statement
        line, a signed receipt email, a countersigned invoice. Your browser
        computes its SHA-256 locally; the file never leaves this machine and
        there is nowhere on the server for it to land. What gets stored is the
        64 character fingerprint and your label. Later, showing the original
        to anyone lets them recompute the hash and check it against this
        record. That makes the deal{" "}
        <span className="text-ink">evidence committed, not yet independently verified</span>
        : we hold a fingerprint, not proof.
      </p>
      <p className="mt-2 text-[0.75rem] text-ink-faint">
        Check the file before committing. A committed hash cannot be replaced.
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
          <p className="font-mono text-[0.75rem] text-ink-faint">hashing locally…</p>
        ) : null}

        {hash ? (
          <div className="border border-rule bg-panel-2 px-3 py-2.5">
            <div className="bt-label">SHA-256 of {fileName ?? "the file"}</div>
            <div className="mt-1 break-all font-mono text-[0.6875rem] leading-relaxed text-amber">
              {hash}
            </div>
          </div>
        ) : null}

        {hash ? (
          <label className="block">
            <span className="bt-label">Label</span>
            <input
              className="bt-input mt-2"
              maxLength={MAX_LABEL}
              placeholder="Mercury statement Aug 2026"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={phase === "sending"}
            />
            <span className="mt-1.5 block text-[0.6875rem] text-ink-faint">
              A few words saying what the original is. Stored next to the hash.
            </span>
          </label>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={commit}
            disabled={!hash || label.trim().length === 0 || phase === "sending"}
            className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
          >
            {phase === "sending"
              ? "Committing…"
              : hash
                ? `Commit ${hashShort(hash)}…`
                : "Pick a file first"}
          </button>
          {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}
