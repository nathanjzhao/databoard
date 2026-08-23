/**
 * /deals
 *
 * The viewer's ledger, in three groups: splits waiting on their own
 * confirmation (prominent, full table, the exact-implications card), deals
 * waiting on other people, and settled history. Everything on this page is
 * participant-only, so exact dollar figures are fine here; the rounding rule
 * applies to public surfaces, not to the people on the deal.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { BuyerChip } from "@/components/ask/meta";
import { timeAgo } from "@/components/matches/format";
import { SplitTable } from "@/components/deals/split-table";
import { ConfirmCard } from "@/components/deals/confirm-card";
import { TierTag } from "@/components/deals/tier-ladder";
import { RecordDealButton } from "@/components/deals/record-deal-link";
import { confirmedFraction, usdExact } from "@/components/deals/format";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { listDealsFor, type DealDetail } from "@/lib/deals";

export const metadata: Metadata = { title: "Deals" };
export const dynamic = "force-dynamic";

const EYEBROW = "Deals";
const TITLE = "The ledger of what actually closed.";
const BLURB =
  "Deals are reported by one account and confirmed, share by share, by the " +
  "people named on them. Amounts are stored exactly and shown exactly to the " +
  "people on the deal; everyone else gets rounded numbers, and a claim " +
  "nobody co-signed goes nowhere.";

export default async function DealsPage() {
  if (!isDbConfigured()) {
    return (
      <PageStub eyebrow={EYEBROW} title={TITLE} blurb={BLURB}>
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const ledger = await listDealsFor(user.id);
  const { needsMyConfirmation, awaitingOthers, history } = ledger;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-14">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="bt-label">{EYEBROW}</div>
          <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
            {TITLE}
          </h1>
          <p className="mt-4 max-w-[62ch] text-[0.9375rem] leading-relaxed text-ink-dim">
            {BLURB}
          </p>
        </div>
        <div className="pt-2">
          <RecordDealButton />
        </div>
      </div>

      {/* ---------------------------------------- needs my confirmation */}
      <section className="mt-12">
        <div className="flex items-baseline gap-3">
          <h2 className="bt-display text-[1.5rem] text-ink">
            Needs your confirmation
          </h2>
          {needsMyConfirmation.length > 0 ? (
            <span className="bt-token">{needsMyConfirmation.length} pending</span>
          ) : null}
        </div>
        <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          Someone reported a deal with your name on a share. Read the split,
          then answer for your own row; nobody else can answer for you.
        </p>
        <div className="mt-4 space-y-6">
          {needsMyConfirmation.length === 0 ? (
            <div className="border border-rule bg-panel px-5 py-4 text-[0.8125rem] text-ink-faint">
              Nothing waiting on you.
            </div>
          ) : (
            needsMyConfirmation.map((d) => (
              <PendingDealCard key={d.id} deal={d} viewerId={user.id} />
            ))
          )}
        </div>
      </section>

      {/* --------------------------------------------- awaiting others */}
      <section className="mt-12">
        <h2 className="bt-display text-[1.5rem] text-ink">Awaiting others</h2>
        <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          Your row is settled; someone else&apos;s is not. Deals sit at
          claimed tier until every non-declined participant has answered.
        </p>
        <div className="mt-4">
          {awaitingOthers.length === 0 ? (
            <div className="border border-rule bg-panel px-5 py-4 text-[0.8125rem] text-ink-faint">
              Nothing in flight.
            </div>
          ) : (
            <ul className="divide-y divide-rule border border-rule bg-panel">
              {awaitingOthers.map((d) => (
                <DealRow key={d.id} deal={d} viewerId={user.id} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* --------------------------------------------------- history */}
      <section className="mt-12">
        <h2 className="bt-display text-[1.5rem] text-ink">History</h2>
        <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          Settled deals: co-attested, evidence committed, declined out, and
          solo entries.
        </p>
        <div className="mt-4">
          {history.length === 0 ? (
            <div className="border border-rule bg-panel px-5 py-4 text-[0.8125rem] text-ink-faint">
              No settled deals yet.{" "}
              <Link href="/deals/new" className="text-blue hover:text-amber">
                Record the first one
              </Link>
              .
            </div>
          ) : (
            <ul className="divide-y divide-rule border border-rule bg-panel">
              {history.map((d) => (
                <DealRow key={d.id} deal={d} viewerId={user.id} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ components */

/** The prominent card: full split plus the confirm-or-decline decision. */
function PendingDealCard({
  deal,
  viewerId,
}: {
  deal: DealDetail;
  viewerId: string;
}) {
  return (
    <section className="border-2 border-ink bg-panel">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-5 py-3">
        <BuyerChip token={deal.buyerToken} isOther={deal.buyerIsOther} />
        <span className="font-mono text-[0.9375rem] tabular-nums text-ink">
          {usdExact(deal.totalUsd)}
        </span>
        <span className="text-[0.8125rem] text-ink-dim">
          reported by <span className="font-mono">@{deal.reporterUsername}</span>
        </span>
        <span className="ml-auto flex items-baseline gap-3">
          <span className="font-mono text-[0.6875rem] text-ink-faint">
            {confirmedFraction(deal.confirmedCount, deal.namedCount)}
          </span>
          <span className="bt-label">{timeAgo(deal.createdAt)}</span>
        </span>
      </header>
      {deal.note ? (
        <p className="border-b border-rule px-5 py-3 text-[0.8125rem] leading-relaxed text-ink-dim">
          {deal.note}
        </p>
      ) : null}
      <div className="px-5 py-4">
        <SplitTable split={deal.split} totalUsd={deal.totalUsd} viewerId={viewerId} />
      </div>
      <div className="px-5 pb-5">
        <ConfirmCard
          dealId={deal.id}
          reporterUsername={deal.reporterUsername}
          myShareUsd={deal.viewer.shareUsd}
        />
      </div>
      <footer className="flex flex-wrap items-center gap-4 border-t border-rule px-5 py-3 text-[0.75rem]">
        <Link href={`/deals/${deal.id}`} className="text-blue hover:text-amber">
          Full deal record
        </Link>
        {deal.threadId ? (
          <Link href={`/messages/${deal.threadId}`} className="text-blue hover:text-amber">
            Deal room thread
          </Link>
        ) : null}
      </footer>
    </section>
  );
}

/** Compact row for the awaiting-others and history groups. */
function DealRow({ deal, viewerId }: { deal: DealDetail; viewerId: string }) {
  const mineDeclined = deal.viewer.status === "declined";
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <BuyerChip token={deal.buyerToken} isOther={deal.buyerIsOther} dim={mineDeclined} />
        <Link
          href={`/deals/${deal.id}`}
          className="font-mono text-[0.9375rem] tabular-nums text-ink hover:text-amber"
        >
          {usdExact(deal.totalUsd)}
        </Link>
        <TierTag tier={deal.tier} />
        <span className="font-mono text-[0.6875rem] text-ink-faint">
          {confirmedFraction(deal.confirmedCount, deal.namedCount)}
        </span>
        <span className="ml-auto bt-label">{timeAgo(deal.createdAt)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.75rem] text-ink-faint">
        <span>
          {deal.reporterId === viewerId ? (
            "reported by you"
          ) : (
            <>
              reported by{" "}
              <span className="font-mono">@{deal.reporterUsername}</span>
            </>
          )}
        </span>
        <span className="font-mono tabular-nums">
          your share {usdExact(deal.viewer.shareUsd)}
          {mineDeclined ? " (declined)" : ""}
        </span>
        {deal.askTitle ? <span className="truncate">re: {deal.askTitle}</span> : null}
        {deal.threadId ? (
          <Link href={`/messages/${deal.threadId}`} className="text-blue hover:text-amber">
            deal room
          </Link>
        ) : null}
      </div>
    </li>
  );
}
