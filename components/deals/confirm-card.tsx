"use client";

/**
 * components/deals/confirm-card.tsx
 *
 * The confirm-or-decline card a named participant sees on a deal where their
 * row is still pending. Spells out exactly what confirming implies before
 * offering the button, because a confirmation here feeds the leaderboard and
 * should not be a reflex click.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usdExact } from "@/components/deals/format";

type Phase = "idle" | "confirming" | "declining" | "done";

export function ConfirmCard({
  dealId,
  reporterUsername,
  myShareUsd,
}: {
  dealId: string;
  reporterUsername: string;
  myShareUsd: number;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  async function act(action: "confirm" | "decline") {
    setPhase(action === "confirm" ? "confirming" : "declining");
    setError(null);
    try {
      const res = await fetch(`/api/deals/${encodeURIComponent(dealId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went sideways. Try again.");
        setPhase("idle");
        return;
      }
      setPhase("done");
      router.refresh();
    } catch {
      setError("Network hiccup. Try again.");
      setPhase("idle");
    }
  }

  if (phase === "done") {
    return (
      <p className="text-[0.8125rem] text-green">
        Recorded. Your answer is on the row now.
      </p>
    );
  }

  const busy = phase === "confirming" || phase === "declining";

  return (
    <div className="border-l-2 border-amber bg-amber-wash px-4 py-3.5">
      <div className="bt-label text-amber">Confirming means</div>
      <ul className="mt-2 space-y-1.5 text-[0.8125rem] leading-relaxed text-ink-dim">
        <li>
          You attest this deal happened and your cut was exactly{" "}
          <span className="font-mono text-ink">{usdExact(myShareUsd)}</span>.
        </li>
        <li>
          You attest that <span className="font-mono">@{reporterUsername}</span>{" "}
          brought you into it. They will count you as a collaborator they
          brought in, and your confirmed share counts toward the value they
          brought to others.
        </li>
        <li>
          Your confirmed share also counts toward your own totals on the
          leaderboard.
        </li>
        <li>
          Exact figures stay between the people on this deal. Public surfaces
          round to the nearest $10k.
        </li>
      </ul>
      <p className="mt-2.5 text-[0.75rem] leading-relaxed text-ink-faint">
        Declining is final for this row and never counts anywhere, for you or
        for them. Other participants&apos; confirmations stand either way.
      </p>
      <div className="mt-3.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => act("confirm")}
          disabled={busy}
          className="bt-btn bt-btn-primary px-4 py-1.5 text-[0.8125rem]"
        >
          {phase === "confirming" ? "Confirming…" : `Confirm my ${usdExact(myShareUsd)}`}
        </button>
        <button
          type="button"
          onClick={() => act("decline")}
          disabled={busy}
          className="bt-btn px-4 py-1.5 text-[0.8125rem]"
        >
          {phase === "declining" ? "Declining…" : "Decline"}
        </button>
        {error ? <span className="text-[0.75rem] text-red">{error}</span> : null}
      </div>
    </div>
  );
}
