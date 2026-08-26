"use client";

/**
 * components/invites/code-controls.tsx
 *
 * The two client-side pieces of the codes block: the mint button (POST
 * /api/invites, then refresh so the new code renders server-side) and the
 * per-code copy button. Everything else on /invites renders on the server.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MintInviteButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invites", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not mint a code. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={mint}
        disabled={busy}
        className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
      >
        {busy ? "Minting…" : "Mint a code"}
      </button>
      {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
    </div>
  );
}

export function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied: the code is on screen either way */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="bt-btn px-2.5 py-1 font-mono text-[0.6875rem]"
      title="Copy the code"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
