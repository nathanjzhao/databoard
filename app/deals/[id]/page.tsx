/**
 * /deals/[id]
 *
 * The full record of one deal, for its participants and nobody else. A deal
 * the viewer is not on 404s, indistinguishable from one that does not exist,
 * same policy as threads. Exact dollars are shown because everyone allowed
 * on this page is on the deal; the nearest-$10k rounding applies to public
 * surfaces, not here.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { BuyerChip } from "@/components/ask/meta";
import { timeAgo } from "@/components/matches/format";
import { SplitTable } from "@/components/deals/split-table";
import { TierLadder, TierTag } from "@/components/deals/tier-ladder";
import { ConfirmCard } from "@/components/deals/confirm-card";
import { EvidenceCommit } from "@/components/deals/evidence-commit";
import { ReceiptPanel } from "@/components/deals/receipt-panel";
import { PartyAttest } from "@/components/deals/party-attest";
import { confirmedFraction, usdExact } from "@/components/deals/format";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { buyerShort } from "@/lib/crypto";
import { getDealForUser, type DealDetail } from "@/lib/deals";
import {
  CERTIFICATE_DISPUTE_WINDOW_DAYS,
  provenanceLine,
  partyBaseFieldsFromPayload,
} from "@/lib/receipts";
import { loggedReceiptForDeal } from "@/lib/translog";

export const metadata: Metadata = { title: "Deal" };
export const dynamic = "force-dynamic";

export default async function DealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <PageStub
        eyebrow="Deals"
        title="The ledger of what actually closed."
        blurb="Deals are reported by one account and confirmed share by share."
      >
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const { id } = await params;
  const deal = await getDealForUser(id, user.id);
  if (!deal) notFound();

  const solo = deal.namedCount === 0;
  const canCommitEvidence =
    deal.viewer.status === "confirmed" &&
    !deal.viewer.evidenceHash &&
    (deal.tier === "co_attested" || solo);

  // A co-attested-or-better deal mints a portable receipt; a claimed or solo
  // deal mints nothing, so the affordance simply is not there. The token is
  // bound to the append-only log (lib/translog.ts): it carries the seq and
  // leaf hash of its receipt_minted leaf, so the verifier can prove the
  // receipt sits in the public log at a signed tree size, not merely that the
  // operator's MAC is intact. Idempotent, so the token is stable per state;
  // falls back to an unlogged receipt if the log is unreachable.
  const logged = await loggedReceiptForDeal(deal);
  const receiptPayload = logged?.payload ?? null;
  const receiptToken = logged?.token ?? null;

  return (
    <div className="mx-auto w-full max-w-[900px] px-5 py-12">
      <div className="bt-label">
        <Link href="/deals" className="hover:text-amber">
          Deals
        </Link>{" "}
        / record
      </div>

      {/* ------------------------------------------------------- header */}
      <header className="mt-4 border border-rule bg-panel px-6 py-5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <BuyerChip token={deal.buyerToken} isOther={deal.buyerIsOther} />
          <span className="font-mono text-[1.75rem] leading-none tabular-nums text-ink">
            {usdExact(deal.totalUsd)}
          </span>
          <TierTag tier={deal.tier} />
          <span className="ml-auto flex items-baseline gap-3">
            <span className="font-mono text-[0.75rem] text-ink-faint">
              {confirmedFraction(deal.confirmedCount, deal.namedCount)}
            </span>
            <span className="bt-label">{timeAgo(deal.createdAt)}</span>
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[0.8125rem] text-ink-dim">
          <span>
            reported by{" "}
            <span className="font-mono">
              @{deal.reporterUsername}
              {deal.reporterId === user.id ? " (you)" : ""}
            </span>
          </span>
          {deal.askId && deal.askTitle ? (
            <Link href={`/ask/${deal.askId}`} className="text-blue hover:text-amber">
              re: {deal.askTitle}
            </Link>
          ) : null}
          {deal.threadId ? (
            <Link href={`/messages/${deal.threadId}`} className="text-blue hover:text-amber">
              deal room thread
            </Link>
          ) : null}
        </div>
        {deal.note ? (
          <p className="mt-3 max-w-[68ch] border-t border-rule pt-3 text-[0.8125rem] leading-relaxed text-ink-dim">
            {deal.note}
          </p>
        ) : null}
      </header>

      {/* ------------------------------------------------------- ladder */}
      <section className="mt-8">
        <h2 className="bt-label">Verification ladder</h2>
        <div className="mt-3">
          <TierLadder tier={deal.tier} solo={solo} />
        </div>
      </section>

      {/* -------------------------------------------------------- split */}
      <section className="mt-8">
        <h2 className="bt-label">The split</h2>
        <div className="mt-3 border border-rule bg-panel px-5 py-4">
          <SplitTable split={deal.split} totalUsd={deal.totalUsd} viewerId={user.id} />
        </div>
      </section>

      {/* ------------------------------------------------------ receipt */}
      {receiptToken && receiptPayload ? (
        <section className="mt-8">
          <h2 className="bt-label">Receipt</h2>
          <div className="mt-3">
            <ReceiptPanel
              token={receiptToken}
              attests={{
                tier: receiptPayload.tier,
                participants: receiptPayload.participants,
                amountBucket: receiptPayload.amountBucket,
                buyerShort: buyerShort(deal.buyerToken),
                buyerIsOther: deal.buyerIsOther,
              }}
              provenance={provenanceLine({
                tier: receiptPayload.tier,
                buyerShort: buyerShort(deal.buyerToken),
                buyerIsOther: deal.buyerIsOther,
                amountBucket: receiptPayload.amountBucket,
                participants: receiptPayload.participants,
                attestedAt: receiptPayload.attestedAt,
              })}
              disputeWindowDays={CERTIFICATE_DISPUTE_WINDOW_DAYS}
            />
          </div>
          {/* Party signatures: each confirmed participant can sign the receipt
              with their own key, so the operator cannot forge a co-attested
              one. Present only once at least one party holds a signing key. */}
          {receiptPayload.attest && receiptPayload.log
            ? (() => {
                const fields = partyBaseFieldsFromPayload(receiptPayload);
                if (!fields) return null;
                return (
                  <div className="mt-3">
                    <PartyAttest
                      dealId={deal.id}
                      viewerHandle={user.username}
                      viewerInRoster={fields.signers.some(
                        (s) => s.handle === user.username,
                      )}
                      viewerConfirmed={deal.viewer.status === "confirmed"}
                      fields={fields}
                      sigs={receiptPayload.attest.sigs}
                    />
                  </div>
                );
              })()
            : null}
        </section>
      ) : null}

      {/* ----------------------------------------------------- exchange */}
      {!solo &&
      deal.viewer.status === "confirmed" &&
      (deal.tier === "co_attested" || deal.tier === "evidence_committed") ? (
        <section className="mt-8">
          <h2 className="bt-label">Dataset exchange</h2>
          <div className="mt-3 border border-rule bg-panel px-5 py-4">
            <p className="max-w-[68ch] text-[0.8438rem] leading-relaxed text-ink-dim">
              Run the actual data handoff on the smallest trust it needs:
              commit, encrypt, pay, reveal, each step signed by the party that
              took it. It bounds and evidences cheating; it is not atomic. The
              server stores commitments and signatures only, never the data or
              the key.
            </p>
            <Link
              href={`/deals/${deal.id}/exchange`}
              className="bt-btn bt-btn-primary mt-3 inline-block px-4 py-1.5 text-[0.8125rem]"
            >
              Open the exchange
            </Link>
          </div>
        </section>
      ) : null}

      {/* ----------------------------------------------------- timeline */}
      <section className="mt-8">
        <h2 className="bt-label">Timeline</h2>
        <Timeline deal={deal} />
      </section>

      {/* ------------------------------------------------------ actions */}
      {deal.viewer.status === "pending" ? (
        <section className="mt-8">
          <h2 className="bt-label">Your answer</h2>
          <div className="mt-3">
            <ConfirmCard
              dealId={deal.id}
              reporterUsername={deal.reporterUsername}
              myShareUsd={deal.viewer.shareUsd}
            />
          </div>
        </section>
      ) : null}

      {canCommitEvidence ? (
        <section className="mt-8">
          <h2 className="bt-label">Evidence</h2>
          <div className="mt-3">
            <EvidenceCommit dealId={deal.id} />
          </div>
          {solo ? (
            <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-faint">
              On a solo deal the hash sits on your row for your own records;
              the deal itself stays claimed tier, because nobody else has
              attested to it.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- timeline */

type TimelineEvent = { at: number | null; text: string; tone: "ink" | "green" | "ghost" };

function Timeline({ deal }: { deal: DealDetail }) {
  const events: TimelineEvent[] = [
    {
      at: deal.createdAt,
      text: `@${deal.reporterUsername} reported the deal · claimed tier`,
      tone: "ink",
    },
  ];
  for (const row of deal.split) {
    if (row.role === "reporter") continue;
    if (row.status === "confirmed") {
      events.push({
        at: row.confirmedAt,
        text: `@${row.username} confirmed their ${usdExact(row.shareUsd)} share`,
        tone: "green",
      });
    } else if (row.status === "declined") {
      events.push({
        at: null,
        text: `@${row.username} declined; their row counts nowhere`,
        tone: "ghost",
      });
    }
  }
  const stamped = events
    .filter((e) => e.at != null)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const unstamped = events.filter((e) => e.at == null);

  const tierNote =
    deal.tier === "evidence_committed"
      ? "Evidence committed: every confirmed account holds a hash on file. Not yet independently verified."
      : deal.tier === "co_attested"
        ? "Co-attested: every non-declined participant has confirmed."
        : deal.namedCount === 0
          ? "Solo deal: stays claimed tier."
          : `Claimed: waiting on ${deal.pendingCount} ${deal.pendingCount === 1 ? "answer" : "answers"}.`;

  return (
    <ol className="mt-3 space-y-0 border-l border-rule-strong pl-5">
      {[...stamped, ...unstamped].map((e, i) => (
        <li key={i} className="relative py-2">
          <span
            className={[
              "absolute -left-[23px] top-[15px] h-[7px] w-[7px] rounded-full",
              e.tone === "green" ? "bg-green" : e.tone === "ghost" ? "bg-ink-ghost" : "bg-amber",
            ].join(" ")}
            aria-hidden
          />
          <span
            className={[
              "text-[0.8125rem]",
              e.tone === "ghost" ? "text-ink-ghost" : "text-ink-dim",
            ].join(" ")}
          >
            {e.text}
          </span>
          {e.at != null ? (
            <span className="ml-3 bt-label">{timeAgo(e.at)}</span>
          ) : null}
        </li>
      ))}
      <li className="relative py-2">
        <span
          className="absolute -left-[23px] top-[15px] h-[7px] w-[7px] rounded-full bg-panel-3 ring-1 ring-rule-strong"
          aria-hidden
        />
        <span className="text-[0.8125rem] text-ink-faint">{tierNote}</span>
      </li>
    </ol>
  );
}
