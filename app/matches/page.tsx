/**
 * /matches
 *
 * Three things live here, all computed from what is already on the board:
 *
 *   1. Incoming collaboration requests on the viewer's asks, with accept and
 *      decline. Accept opens a private thread and goes straight to it.
 *   2. Asks the viewer offered on, with the OTHER suppliers holding a live
 *      offer on the same ask. A supplier with no asks of their own pools
 *      from here: "propose pooling" opens a direct thread, vouched by the
 *      shared ask (both sides must hold a live request on it).
 *   3. Buyer overlap: live asks by other members whose buyer token equals a
 *      token on one of the viewer's asks. Tokens match if and only if the
 *      posters typed the same buyer, so the page can say "same buyer"
 *      without anyone learning which buyer.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { CollabInbox } from "@/components/matches/collab-inbox";
import { ProposeCollab } from "@/components/matches/propose-collab";
import { ProposePooling } from "@/components/matches/propose-pooling";
import { TermsChip } from "@/components/ask/terms";
import { timeAgo } from "@/components/matches/format";
import { getSessionUser } from "@/lib/auth";
import { isDbConfigured } from "@/lib/db";
import { buyerShort } from "@/lib/crypto";
import {
  countOwnAsks,
  findBuyerMatches,
  listCoOfferedAsks,
  listIncomingCollabRequests,
  listOutgoingCollabRequests,
  type BuyerMatchGroup,
  type CoOfferedAsk,
  type MatchedAsk,
  type OutgoingCollab,
  type OwnAsk,
} from "@/lib/matching";
import { categoryLabel, STATUS_LABEL } from "@/lib/taxonomy";

export const metadata: Metadata = { title: "Matches" };
export const dynamic = "force-dynamic";

export default async function MatchesPage() {
  if (!isDbConfigured()) {
    return (
      <PageStub
        eyebrow="Matches"
        title="Same buyer, shared problem."
        blurb="Overlap is computed on buyer tokens, never names."
      >
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const [groups, incoming, outgoing, offered, ownAskCount] = await Promise.all([
    findBuyerMatches(user.id),
    listIncomingCollabRequests(user.id),
    listOutgoingCollabRequests(user.id),
    listCoOfferedAsks(user.id),
    countOwnAsks(user.id),
  ]);

  const matchCount = groups.reduce((n, g) => n + g.otherAsks.length, 0);
  const coSupplierCount = offered.reduce((n, a) => n + a.others.length, 0);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-14">
      <div className="bt-label">Matches</div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        Same buyer, shared problem.
      </h1>
      <p className="mt-4 max-w-[62ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        Asks whose buyer token matches one of yours, and the other suppliers
        on asks you offered to fill. Tokens collide only when two posters
        typed the same buyer; nobody sees the name.
      </p>

      {/* ------------------------------------------ incoming requests */}
      <section className="mt-12">
        <div className="flex items-baseline gap-3">
          <h2 className="bt-display text-[1.5rem] text-ink">Needs a decision</h2>
          {incoming.length > 0 ? (
            <span className="bt-token">{incoming.length} pending</span>
          ) : null}
        </div>
        <div className="mt-4">
          {incoming.length > 0 ? (
            <CollabInbox
              requests={incoming.map((r) => ({
                id: r.id,
                askId: r.askId,
                askTitle: r.askTitle,
                note: r.note,
                createdAt: r.createdAt,
                requesterUsername: r.requesterUsername,
              }))}
            />
          ) : (
            <div className="border border-rule bg-panel px-5 py-4 text-[0.8125rem] text-ink-faint">
              Nothing pending on your asks right now.
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------- asks you offered on */}
      <section className="mt-12">
        <div className="flex items-baseline gap-3">
          <h2 className="bt-display text-[1.5rem] text-ink">
            Asks you offered on
          </h2>
          {offered.length > 0 ? (
            <span className="bt-token">
              {offered.length} {offered.length === 1 ? "ask" : "asks"}
              {coSupplierCount > 0
                ? ` · ${coSupplierCount} other ${
                    coSupplierCount === 1 ? "supplier" : "suppliers"
                  }`
                : ""}
            </span>
          ) : null}
        </div>
        <p className="mt-2 max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-dim">
          You do not need an ask of your own to pool. Everyone with a live
          offer on the same ask shows up here; filling it together beats
          undercutting each other into a discount.
        </p>

        {offered.length === 0 ? (
          <div className="mt-4 border border-rule bg-panel px-6 py-10 text-center">
            <p className="mx-auto max-w-[52ch] text-[0.875rem] leading-relaxed text-ink-faint">
              You have no live offers out. This section starts when you open
              an ask on{" "}
              <Link href="/" className="text-blue hover:text-amber">
                the board
              </Link>{" "}
              and say &ldquo;I have some of that&rdquo;; the other suppliers
              on it appear here.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {offered.map((a) => (
              <OfferedAskCard key={a.askId} ask={a} />
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------- buyer overlap */}
      <section className="mt-12">
        <div className="flex items-baseline gap-3">
          <h2 className="bt-display text-[1.5rem] text-ink">Buyer overlap</h2>
          {matchCount > 0 ? (
            <span className="bt-token">
              {matchCount} {matchCount === 1 ? "ask" : "asks"} across{" "}
              {groups.length} {groups.length === 1 ? "buyer" : "buyers"}
            </span>
          ) : null}
        </div>

        {groups.length === 0 ? (
          <div className="mt-4 border border-rule bg-panel px-6 py-10 text-center">
            {ownAskCount === 0 ? (
              <p className="mx-auto max-w-[52ch] text-[0.875rem] leading-relaxed text-ink-faint">
                You have not posted an ask, so there is nothing to match
                against yet. Buyer overlap anchors on your own asks:{" "}
                <Link href="/new" className="text-blue hover:text-amber">
                  put one on the board
                </Link>{" "}
                and this section starts working.
              </p>
            ) : (
              <p className="mx-auto max-w-[52ch] text-[0.875rem] leading-relaxed text-ink-faint">
                No live asks by anyone else share a buyer token with yours
                right now. Overlap appears the moment another member names
                one of your buyers.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-8">
            {groups.map((g) => (
              <MatchGroup key={g.buyerToken} group={g} outgoing={outgoing} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ components */

/**
 * One ask the viewer has a live offer on, with everyone else offering into
 * it. Each co-supplier row carries the door: propose pooling, which opens a
 * direct thread vouched by the shared ask.
 */
function OfferedAskCard({ ask }: { ask: CoOfferedAsk }) {
  return (
    <section className="border border-rule bg-panel">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-5 py-3">
        <Link
          href={`/ask/${ask.askId}`}
          className="text-[0.9375rem] text-ink transition-colors hover:text-amber"
        >
          {ask.askTitle}
        </Link>
        <span className="font-mono text-[0.75rem] text-ink-dim">
          @{ask.posterUsername}
        </span>
        <span className="ml-auto flex items-baseline gap-3">
          <span className="font-mono text-[0.6875rem] text-ink-faint">
            {ask.supplyFilledPct}% filled
          </span>
          <span
            className={[
              "font-mono text-[0.625rem] uppercase tracking-[0.1em]",
              ask.askStatus === "open" ? "text-amber" : "text-green",
            ].join(" ")}
          >
            {STATUS_LABEL[ask.askStatus]}
          </span>
          <span
            className={[
              "font-mono text-[0.625rem] uppercase tracking-[0.1em]",
              ask.myStatus === "accepted" ? "text-green" : "text-ink-faint",
            ].join(" ")}
          >
            your offer {ask.myStatus}
          </span>
        </span>
      </header>

      {ask.others.length === 0 ? (
        <p className="px-5 py-4 text-[0.8125rem] leading-relaxed text-ink-faint">
          Nobody else has offered on this ask yet. You are first in line;
          anyone who follows lands here.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {ask.others.map((o) => (
            <li
              key={o.username}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3"
            >
              <span className="flex min-w-0 items-baseline gap-3">
                <span className="truncate font-mono text-[0.8125rem] text-ink">
                  @{o.username}
                </span>
                <span
                  className={[
                    "font-mono text-[0.625rem] uppercase tracking-[0.1em]",
                    o.status === "accepted" ? "text-green" : "text-ink-faint",
                  ].join(" ")}
                >
                  offer {o.status}
                </span>
              </span>
              <ProposePooling askId={ask.askId} username={o.username} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MatchGroup({
  group,
  outgoing,
}: {
  group: BuyerMatchGroup;
  outgoing: Record<string, OutgoingCollab>;
}) {
  const n = group.otherAsks.length;
  const bothUnderFilled =
    group.myAsks.some((a) => a.status !== "closed" && a.supplyFilledPct < 100) &&
    group.otherAsks.some((a) => a.supplyFilledPct < 100);

  return (
    <section className="border border-rule bg-panel">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-5 py-3">
        <span className="bt-token text-[0.9375rem]">
          Buyer #{buyerShort(group.buyerToken)}
        </span>
        {group.buyerIsOther ? (
          <span
            className="bt-label"
            title="This buyer was typed into the free-text field, not picked from the list. Identical names still collide."
          >
            off list
          </span>
        ) : null}
        <span className="text-[0.8125rem] text-ink-dim">
          {n === 1 ? "1 other ask names" : `${n} other asks name`} the same
          buyer as {group.myAsks.length === 1 ? "your ask" : "your asks"}.
        </span>
      </header>

      <SupplyPicture myAsks={group.myAsks} otherAsks={group.otherAsks} />

      {bothUnderFilled ? (
        <p className="mx-5 mb-1 border-l-2 border-amber bg-amber-wash px-4 py-3 text-[0.8125rem] leading-relaxed text-ink-dim">
          Both sides are under-filled: pooled supply closes the ask,
          undercutting just moves the discount.
        </p>
      ) : null}

      <ul className="divide-y divide-rule">
        {group.otherAsks.map((a) => (
          <MatchedAskRow key={a.id} ask={a} outgoing={outgoing[a.id] ?? null} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The combined supply picture: every ask pointed at this buyer, yours and
 * theirs, as one stack of fill bars. Shared versus competitive supply at a
 * glance, with each ask's stated terms on its bar: exclusivity decides
 * whether overlap here means pooling or competition.
 */
function SupplyPicture({
  myAsks,
  otherAsks,
}: {
  myAsks: OwnAsk[];
  otherAsks: MatchedAsk[];
}) {
  const live = [...myAsks, ...otherAsks].filter((a) => a.status !== "closed");
  const anyExclusive = live.some((a) => a.exclusivity === "exclusive");
  const allNonexclusive =
    live.length > 0 && live.every((a) => a.exclusivity === "nonexclusive");

  return (
    <div className="px-5 py-4">
      <div className="bt-label">Supply picture</div>
      <div className="mt-3 space-y-2">
        {myAsks.map((a) => (
          <SupplyBar
            key={a.id}
            who="you"
            title={a.title}
            pct={a.supplyFilledPct}
            status={STATUS_LABEL[a.status]}
            exclusivity={a.exclusivity}
            mine
          />
        ))}
        {otherAsks.map((a) => (
          <SupplyBar
            key={a.id}
            who={`@${a.posterUsername}`}
            title={a.title}
            pct={a.supplyFilledPct}
            status={STATUS_LABEL[a.status]}
            exclusivity={a.exclusivity}
            mine={false}
          />
        ))}
      </div>
      {anyExclusive ? (
        <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-faint">
          An ask in this stack states exclusive terms: supply sold into it
          cannot be reused for the others, so overlap there is competition,
          not shared supply.
        </p>
      ) : allNonexclusive ? (
        <p className="mt-3 text-[0.6875rem] leading-relaxed text-ink-faint">
          Every stated term here is non-exclusive: the same supply may serve
          more than one of these asks.
        </p>
      ) : null}
    </div>
  );
}

function SupplyBar({
  who,
  title,
  pct,
  status,
  exclusivity,
  mine,
}: {
  who: string;
  title: string;
  pct: number;
  status: string;
  exclusivity: MatchedAsk["exclusivity"];
  mine: boolean;
}) {
  const fill = pct >= 100 ? "var(--bt-green)" : mine ? "var(--bt-amber)" : "var(--bt-blue)";
  return (
    <div className="flex items-center gap-3">
      <span
        className={[
          "w-28 shrink-0 truncate text-right font-mono text-[0.6875rem]",
          mine ? "text-amber" : "text-ink-dim",
        ].join(" ")}
        title={title}
      >
        {who}
      </span>
      <div className="h-2 flex-1 border border-rule bg-panel-2">
        <div
          className="h-full"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: fill }}
        />
      </div>
      <span className="w-28 shrink-0 font-mono text-[0.6875rem] text-ink-faint">
        {pct}% filled
      </span>
      <span className="hidden w-24 shrink-0 text-[0.6875rem] text-ink-ghost sm:inline">
        {status}
      </span>
      <span className="hidden shrink-0 md:inline">
        <TermsChip exclusivity={exclusivity} />
      </span>
    </div>
  );
}

function MatchedAskRow({
  ask,
  outgoing,
}: {
  ask: MatchedAsk;
  outgoing: OutgoingCollab | null;
}) {
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[0.9375rem] text-ink">{ask.title}</h3>
        <span className="font-mono text-[0.75rem] text-ink-dim">
          @{ask.posterUsername}
        </span>
        <span className="ml-auto bt-label">{timeAgo(ask.createdAt)}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.75rem] text-ink-faint">
        <span>{categoryLabel(ask.category)}</span>
        {ask.modalityTags.length > 0 ? (
          <span className="font-mono">{ask.modalityTags.join(" · ")}</span>
        ) : null}
        {ask.volume ? <span>{ask.volume}</span> : null}
        {ask.priceBand ? <span>{ask.priceBand}</span> : null}
        <span className={ask.status === "open" ? "text-amber" : "text-green"}>
          {STATUS_LABEL[ask.status]}
        </span>
        <TermsChip exclusivity={ask.exclusivity} />
      </div>

      <div className="mt-3">
        <ProposeCollab
          askId={ask.id}
          existingStatus={outgoing?.status ?? null}
          requestId={outgoing?.requestId}
        />
      </div>
    </li>
  );
}
