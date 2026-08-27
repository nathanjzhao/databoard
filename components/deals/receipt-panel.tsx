"use client";

/**
 * components/deals/receipt-panel.tsx
 *
 * The receipt affordance on an attested deal page. The token is minted
 * server-side (lib/receipts.ts) and passed in; this component only shows it,
 * copies it, and says plainly what it does and does not prove. A claimed-tier
 * deal never reaches here: it mints nothing, and the page renders nothing.
 *
 * Everything shown here is metadata that is already on this page, reduced to a
 * bucket where it is a dollar figure. Handing out the token hands out no more
 * than the deal's own participants can already see, minus the exact amount.
 */

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";

export type ReceiptAttests = {
  tier: "co_attested" | "evidence_committed";
  participants: string[];
  amountBucket: string;
  buyerShort: string;
  buyerIsOther: boolean;
};

const TIER_WORD: Record<ReceiptAttests["tier"], string> = {
  co_attested: "co-attested",
  evidence_committed: "evidence committed",
};

export function ReceiptPanel({
  token,
  attests,
  provenance,
  disputeWindowDays,
}: {
  token: string;
  attests: ReceiptAttests;
  /** One-line provenance for a future counterparty (lib/receipts provenanceLine). */
  provenance: string;
  /** Days either party has to dispute the record on-platform. */
  disputeWindowDays: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-rule bg-panel px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="bt-label">Portable receipt · engagement certificate</div>
        <span className="font-mono text-[0.6875rem] text-ink-faint">
          HMAC-signed, off-platform
        </span>
      </div>

      <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        A compact token that binds this deal&apos;s tier, its confirmed handles,
        the blinded buyer, and the amount rounded to a $10k bucket, signed by the
        platform. Both sides of an attested deal get the same certificate: hand
        it to a future counterparty as a track record, or paste it into{" "}
        <a href="/receipts/verify" className="text-blue hover:text-amber">
          /receipts/verify
        </a>{" "}
        to confirm it is genuine and unaltered, no account needed. A solo,
        unattested deal mints none, so co-attesting is what makes the record
        worth carrying.
      </p>

      {/* the provenance line a holder shows a counterparty */}
      <div className="mt-3.5 border-t border-rule pt-3.5">
        <div className="bt-label">Provenance</div>
        <div className="mt-1 break-words font-mono text-[0.75rem] leading-relaxed text-ink">
          {provenance}
        </div>
      </div>

      {/* what the token attests, bucketed */}
      <dl className="mt-3.5 grid grid-cols-1 gap-x-8 gap-y-2 border-t border-rule pt-3.5 sm:grid-cols-2">
        <Field label="Tier">{TIER_WORD[attests.tier]}</Field>
        <Field label="Amount">{attests.amountBucket} bucket</Field>
        <Field label="Buyer">
          #{attests.buyerShort}
          {attests.buyerIsOther ? " (off-list)" : ""}
        </Field>
        <Field label="Handles">{attests.participants.join(", ")}</Field>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="bt-btn px-3 py-1.5 text-[0.75rem]"
          aria-expanded={open}
        >
          {open ? "Hide token" : "Show token"}
        </button>
        <CopyButton
          value={token}
          label="Copy receipt"
          className="bt-btn-primary px-3 py-1.5 text-[0.75rem]"
        />
      </div>

      {open ? (
        <div className="mt-3 border border-rule bg-panel-2 px-3 py-2.5">
          <div className="bt-label">Receipt token</div>
          <div className="mt-1 break-all font-mono text-[0.6875rem] leading-relaxed text-amber">
            {token}
          </div>
        </div>
      ) : null}

      <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-faint">
        Dispute window: for {disputeWindowDays} days either party can contest
        this deal&apos;s record on-platform. A certificate is a snapshot of the
        deal&apos;s state when it was minted; if the deal later changes tier, it
        mints a different one, so treat a fresh certificate as provisional until
        the window passes.
      </p>

      <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-faint">
        The platform holds the signing key, so it can forge its own receipts: a
        valid receipt proves DataBoard vouches this deal was recorded, not a
        third-party-unforgeable fact.{" "}
        <a
          href="/transparency/verification#receipts"
          className="text-blue hover:text-amber"
        >
          The honest version
        </a>
        .
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="bt-label">{label}</dt>
      <dd className="font-mono text-[0.75rem] leading-snug text-ink">{children}</dd>
    </div>
  );
}
