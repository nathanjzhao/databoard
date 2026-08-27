/**
 * /deals/[id]/exchange
 *
 * The commit-encrypt-pay-reveal dataset handoff for one deal, for its confirmed
 * participants. A deal the viewer is not on 404s, like the deal page itself.
 * All crypto runs in the browser (components/exchange); this server component
 * only authorizes, loads any existing session, and states the honest bound.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { buyerShort } from "@/lib/crypto";
import { getDealForUser } from "@/lib/deals";
import { latestSessionForDeal } from "@/app/api/exchange/store";
import { ExchangePanel } from "@/components/exchange/exchange-panel";

export const metadata: Metadata = { title: "Exchange" };
export const dynamic = "force-dynamic";

export default async function ExchangePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <PageStub
        eyebrow="Exchange"
        title="Commit, encrypt, pay, reveal."
        blurb="A client-side dataset handoff that bounds and evidences cheating."
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

  const viewerConfirmed = deal.viewer.status === "confirmed";
  const counterparties = viewerConfirmed
    ? deal.split
        .filter((r) => r.status === "confirmed" && r.username !== user.username)
        .map((r) => r.username)
    : [];
  const buyerLabel = `Buyer #${buyerShort(deal.buyerToken)}${deal.buyerIsOther ? " (off-list)" : ""}`;
  const initialSession = await latestSessionForDeal(id, user.id);

  return (
    <div className="mx-auto w-full max-w-[900px] px-5 py-12">
      <div className="bt-label">
        <Link href="/deals" className="hover:text-amber">
          Deals
        </Link>{" "}
        /{" "}
        <Link href={`/deals/${id}`} className="hover:text-amber">
          record
        </Link>{" "}
        / exchange
      </div>

      <h1 className="bt-display mt-4 text-[2rem] leading-[1.08] text-ink">
        Commit, encrypt, pay, reveal.
      </h1>
      <p className="mt-3 max-w-[68ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        The dataset handoff, minimized to the smallest trust it can run on. The
        seller commits to encrypted data and a key hash; the buyer verifies the
        ciphertext and signals payment; the seller reveals the key; the buyer
        decrypts and verifies. Every step is signed by the party that took it,
        hash-linked to the last, so the sequence is tamper-evident.
      </p>

      <div className="mt-4 border-l-2 border-amber bg-amber-wash px-4 py-3.5">
        <div className="bt-label text-amber">What this does and does not do</div>
        <p className="mt-2 max-w-[68ch] text-[0.8438rem] leading-relaxed text-ink-dim">
          This bounds and evidences cheating: a party that stops after receiving
          is provable from the signed chain, and chunking caps a stop-after-receiving
          to one chunk. It does not make the trade atomic. Atomic fair exchange
          needs a blockchain or an escrow agent; the full trust ladder, including
          the on-chain Tier B that would add atomicity, is in{" "}
          <span className="font-mono text-[0.75rem]">docs/EXCHANGE.md</span> and on{" "}
          <Link href="/transparency/verification#payment" className="text-blue hover:text-amber">
            the verification page
          </Link>
          . The server here stores commitments, signatures and state only, never
          the data, the key, or any exact figure.
        </p>
      </div>

      <div className="mt-8">
        <ExchangePanel
          dealId={id}
          viewer={user.username}
          buyerLabel={buyerLabel}
          counterparties={counterparties}
          initialSession={initialSession}
        />
      </div>
    </div>
  );
}
