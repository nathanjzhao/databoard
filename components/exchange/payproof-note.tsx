"use client";

/**
 * components/exchange/payproof-note.tsx
 *
 * The honest maturity note for the payment rung of the exchange. It reads
 * GET /api/payproof and says plainly where verifiable proof-of-payment stands:
 * planned (nothing configured, the default), demo (a dev stub that proves
 * nothing about real money), or active (a real verifier is pinned). It never
 * implies the pay step is cryptographic proof a bank moved money; today that
 * step is mutual attestation (F1), and this note says so.
 *
 * Self-contained: no crypto, no props, degrades to "planned" if the status
 * fetch fails, so it is safe to drop anywhere in the panel.
 */

import { useEffect, useState } from "react";

type Status = {
  configured: boolean;
  mode: "unconfigured" | "demo" | "reclaim";
  label: string;
  providerVersion: string | null;
  predicate: string[];
};

const PLANNED: Status = {
  configured: false,
  mode: "unconfigured",
  label: "verifiable proof-of-payment: planned",
  providerVersion: null,
  predicate: [],
};

export function PayProofNote() {
  const [status, setStatus] = useState<Status>(PLANNED);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/payproof", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (live && data?.status) setStatus(data.status as Status);
      })
      .catch(() => {
        /* keep PLANNED */
      });
    return () => {
      live = false;
    };
  }, []);

  const tone =
    status.mode === "reclaim"
      ? "border-green bg-green-wash text-green"
      : status.mode === "demo"
        ? "border-blue bg-panel-2 text-blue"
        : "border-amber bg-amber-wash text-amber";

  return (
    <div className={["border-l-2 px-4 py-3.5", tone].join(" ")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="bt-label">{status.label}</div>
        {status.predicate.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="bt-token text-ink-faint hover:text-ink"
          >
            {open ? "hide predicate" : "the predicate"}
          </button>
        ) : null}
      </div>
      <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        The pay step is a bilateral wire-credit claim: mutual attestation that a
        wire carrying this deal&apos;s reference was sent and observed. That is
        honest evidence, not cryptographic proof a bank credited the money, and a
        credit can still be reversed. A zkTLS proof against the receiving bank,
        verified in the buyer&apos;s browser with the platform logging only its
        hash, is the next rung.{" "}
        <a href="/transparency/verification#payment" className="text-blue hover:text-amber">
          The ladder
        </a>{" "}
        (docs/SETTLEMENT.md) states what each rung removes trust in.
      </p>
      {status.mode === "demo" ? (
        <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-dim">
          A demo verifier is enabled on this instance. It walks the flow and
          proves nothing about real money; every demo result is flagged as such
          and is never counted as a real proof.
        </p>
      ) : null}
      {open && status.predicate.length > 0 ? (
        <div className="mt-3 border border-rule bg-panel px-3 py-2">
          <div className="bt-label">a proof must satisfy</div>
          <ul className="mt-2 space-y-1 font-mono text-[0.6875rem] leading-relaxed text-ink-dim">
            {status.predicate.map((clause) => (
              <li key={clause}>{clause}</li>
            ))}
          </ul>
          {status.providerVersion ? (
            <div className="mt-2 break-all font-mono text-[0.6875rem] text-ink-faint">
              provider version: {status.providerVersion}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
