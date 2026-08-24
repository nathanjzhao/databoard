"use client";

/**
 * components/ask/owner-controls.tsx
 *
 * What a poster can do to their own ask, which is deliberately little:
 * move the supply meter, or close it. Closing is permanent from this panel
 * (there is no reopen button; post again instead), so the close button asks
 * twice.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { statusForPct } from "@/components/ask/format";

const RANGE_CLASS = [
  "w-full cursor-pointer appearance-none bg-transparent focus:outline-none",
  "[&::-webkit-slider-runnable-track]:h-[2px]",
  "[&::-webkit-slider-runnable-track]:bg-rule-strong",
  "[&::-webkit-slider-thumb]:appearance-none",
  "[&::-webkit-slider-thumb]:h-[16px]",
  "[&::-webkit-slider-thumb]:w-[8px]",
  "[&::-webkit-slider-thumb]:-mt-[7px]",
  "[&::-webkit-slider-thumb]:bg-amber",
  "[&::-webkit-slider-thumb]:border",
  "[&::-webkit-slider-thumb]:border-amber-soft",
  "[&::-moz-range-track]:h-[2px]",
  "[&::-moz-range-track]:bg-rule-strong",
  "[&::-moz-range-thumb]:h-[16px]",
  "[&::-moz-range-thumb]:w-[8px]",
  "[&::-moz-range-thumb]:rounded-none",
  "[&::-moz-range-thumb]:border",
  "[&::-moz-range-thumb]:border-amber-soft",
  "[&::-moz-range-thumb]:bg-amber",
].join(" ");

export function OwnerControls({
  askId,
  supplyFilledPct,
  status,
}: {
  askId: string;
  supplyFilledPct: number;
  status: "open" | "partial" | "closed";
}) {
  const router = useRouter();
  const [pct, setPct] = useState(supplyFilledPct);
  const [busy, setBusy] = useState<"save" | "close" | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = pct !== supplyFilledPct;

  async function patch(body: { supplyFilledPct?: number; close?: boolean }) {
    const res = await fetch(`/api/asks/${askId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Update failed.");
    router.refresh();
  }

  async function saveSupply() {
    setBusy("save");
    setError(null);
    try {
      await patch({ supplyFilledPct: pct });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function closeAsk() {
    if (!confirmClose) {
      setConfirmClose(true);
      return;
    }
    setBusy("close");
    setError(null);
    try {
      await patch({ close: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
      setConfirmClose(false);
    }
  }

  if (status === "closed") {
    return (
      <div className="border border-rule bg-panel px-5 py-5">
        <div className="bt-label">Your ask, closed</div>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-dim">
          It stays on the board as a record at {supplyFilledPct}% filled, and
          people can still reach you through it. There is no reopen; post a
          fresh ask if the gap comes back.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-rule bg-panel">
      <div className="border-b border-rule px-5 py-3">
        <span className="bt-label">Your ask</span>
      </div>

      <div className="px-5 py-5">
        <div className="flex items-baseline justify-between">
          <span className="bt-label">Supply filled</span>
          <span className="font-mono text-[1.25rem] leading-none tabular-nums text-amber">
            {pct}
            <span className="text-[0.75rem] text-ink-faint">%</span>
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
          className={`${RANGE_CLASS} mt-4`}
          aria-label="Percent of supply already filled"
        />
        <p className="mt-2 font-mono text-[0.625rem] text-ink-ghost">
          {pct >= 100
            ? "Saving at 100 closes the ask."
            : `Saving sets status to ${statusForPct(pct)}.`}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={saveSupply}
            disabled={!dirty || busy !== null}
            className="bt-btn px-4 py-1.5 text-[0.75rem]"
          >
            {busy === "save" ? "Saving" : "Save supply"}
          </button>
          {dirty && busy === null ? (
            <button
              type="button"
              onClick={() => setPct(supplyFilledPct)}
              className="text-[0.75rem] text-ink-faint hover:text-ink-dim"
            >
              revert
            </button>
          ) : null}
        </div>
      </div>

      <div className="border-t border-rule px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={closeAsk}
            disabled={busy !== null}
            className={[
              "bt-btn px-4 py-1.5 text-[0.75rem]",
              confirmClose
                ? "border-red bg-red-wash text-red hover:border-red"
                : "",
            ].join(" ")}
          >
            {busy === "close"
              ? "Closing"
              : confirmClose
                ? "Confirm close"
                : "Close ask"}
          </button>
          <span className="text-[0.75rem] text-ink-faint">
            {confirmClose
              ? "Permanent. No reopen."
              : "Done, or done enough. Stays visible as closed."}
          </span>
        </div>
      </div>

      {error ? (
        <div className="border-t border-red/40 bg-red-wash px-5 py-3 text-[0.75rem] text-ink">
          {error}
        </div>
      ) : null}
    </div>
  );
}
