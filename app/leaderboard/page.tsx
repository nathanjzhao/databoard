/**
 * /leaderboard
 *
 * The standings. Ranked by collaborators brought into mutually confirmed
 * deals by default, because that is the hardest number on the board to
 * invent; the two dollar columns are one click away. Ranking happens on the
 * server over exact sums; everything this page actually renders is rounded
 * to the nearest $10k, and the exact figures never reach the client.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { LeaderboardBoard } from "@/components/leaderboard/board";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { computeLeaderboard, toPublicLeaderboard } from "@/lib/stats";

export const metadata: Metadata = { title: "Leaderboard" };
export const dynamic = "force-dynamic";

const EYEBROW = "Leaderboard";
const TITLE = "The standings.";
const BLURB =
  "Ranked by who keeps bringing people into deals that both sides signed " +
  "off on. Dollar figures are self-reported, co-attested at best, and " +
  "rounded before they get anywhere near this page. A unilateral claim, one " +
  "nobody co-signed, is worth nothing here: nothing for reputation, the same " +
  "as it is worth nothing for referral fees. It shows only under claimed, " +
  "unranked.";

const RULES: { rule: string; detail: string }[] = [
  {
    rule: "Only mutually confirmed deals count.",
    detail:
      "A share someone declined, or has not answered, is worth nothing to anybody. A solo deal has no counterparty to sign it, so it earns zero on every ranked column and surfaces only in the unranked claimed figure.",
  },
  {
    rule: "Repeat pairs are rate-limited.",
    detail:
      "The same reporter and counterparty count as one collaboration per 30 days, however many deals they confirm inside the window.",
  },
  {
    rule: "Values are self-reported and rounded.",
    detail:
      "Exact sums decide the order on the server; the page shows nearest-$10k. Evidence committed means hashes on file, not yet independently verified.",
  },
];

export default async function LeaderboardPage() {
  if (!isDbConfigured()) {
    return (
      <PageStub eyebrow={EYEBROW} title={TITLE} blurb={BLURB}>
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const board = toPublicLeaderboard(await computeLeaderboard());
  const viewerRanked = board.rows.some((r) => r.username === user.username);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-14">
      <div className="bt-label">{EYEBROW}</div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        {TITLE}
      </h1>
      <p className="mt-4 max-w-[62ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        {BLURB}
      </p>

      {/* ------------------------------------------------- what counts */}
      <div className="mt-8 grid gap-px border border-rule bg-rule sm:grid-cols-3">
        {RULES.map((r, i) => (
          <div key={r.rule} className="bg-panel px-5 py-4">
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[0.625rem] text-amber">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-[0.8125rem] font-medium text-ink">
                {r.rule}
              </span>
            </div>
            <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-faint">
              {r.detail}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[0.75rem] text-ink-faint">
        The full ladder, and everything it does not prove, is documented on{" "}
        <Link
          href="/transparency/verification"
          className="text-blue hover:text-amber"
        >
          the verification page
        </Link>
        .
      </p>

      {/* ------------------------------------------------- ticker strip */}
      <div className="mt-10 grid grid-cols-2 gap-px border border-rule bg-rule md:grid-cols-4">
        <Tile label="Ranked accounts" value={String(board.rankedAccounts)} />
        <Tile label="Co-attested deals" value={String(board.coAttestedDeals)} />
        <Tile
          label="Evidence committed"
          value={String(board.evidenceCommittedDeals)}
        />
        <Tile label="Value on the board" value={board.attributedValue} />
      </div>

      {/* -------------------------------------------- unattested, unranked */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-l-2 border-rule-strong bg-panel px-4 py-3">
        <span className="bt-label text-ink-faint">Claimed (unattested)</span>
        <span className="font-mono text-[1.0625rem] tabular-nums text-ink-dim">
          {board.claimedUnattested}
        </span>
        <p className="max-w-[62ch] text-[0.75rem] leading-relaxed text-ink-faint">
          Solo deals, recorded by one account with no counterparty to attest
          them. Shown for honesty, ranked nowhere: a claim you make about
          yourself moves neither the standings nor a referral fee.
        </p>
      </div>

      {/* ------------------------------------------------------ the board */}
      <div className="mt-6">
        {board.rows.length === 0 ? (
          <div className="border border-rule bg-panel px-6 py-14 text-center">
            <div className="bt-label text-ink-ghost">Nothing to rank</div>
            <p className="mx-auto mt-3 max-w-[46ch] text-[0.875rem] leading-relaxed text-ink-faint">
              No deal has been reported and confirmed yet, so everyone is tied
              at zero. The standings start when somebody{" "}
              <Link href="/deals/new" className="text-blue hover:text-amber">
                records a deal
              </Link>{" "}
              and the people on it sign off.
            </p>
          </div>
        ) : (
          <>
            <LeaderboardBoard rows={board.rows} viewerUsername={user.username} />
            {!viewerRanked ? (
              <p className="mt-3 text-[0.75rem] text-ink-faint">
                You are not on the board yet. It takes one counted share:{" "}
                <Link href="/deals/new" className="text-blue hover:text-amber">
                  report a deal
                </Link>{" "}
                or confirm one that names you on{" "}
                <Link href="/deals" className="text-blue hover:text-amber">
                  your ledger
                </Link>
                .
              </p>
            ) : null}
          </>
        )}
      </div>

    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel px-5 py-4">
      <div className="bt-label">{label}</div>
      <div className="mt-2 font-mono text-[1.375rem] leading-none tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}
