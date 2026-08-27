/**
 * The board. A ledger of open asks: who wants data, what kind, how much of
 * the want is already met, and a four character token where the buyer's name
 * would be on any other site.
 *
 * Server-rendered end to end. Filters are plain links carrying ?cat= and
 * ?status=, so the whole page stays crawl-proof behind the gate and free of
 * client state. Middleware bounced cookie-less visitors already; the
 * getSessionUser() call is the real check.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import {
  BuyerChip,
  CategoryTag,
  MandateMark,
  ModalityTags,
  StatusMark,
  SupplyMeter,
  TrackRecordChip,
} from "@/components/ask/meta";
import { timeAgo } from "@/components/ask/format";
import { TermsChip } from "@/components/ask/terms";
import { getSessionUser } from "@/lib/auth";
import { getDb, isDbConfigured } from "@/lib/db";
import { recordedVolumeByUser } from "@/lib/stats";
import { comparePriority, recordedVolumeChip } from "@/lib/matching";
import { ASK_STATUSES, CATEGORIES, unpackTags, type AskStatus } from "@/lib/taxonomy";
import { isExclusivity, type Exclusivity } from "@/lib/terms";

export const dynamic = "force-dynamic";

type AskRow = {
  id: string;
  title: string;
  category: string;
  modality_tags: string;
  volume: string;
  price_band: string;
  supply_filled_pct: number;
  buyer_token: string;
  buyer_is_other: number;
  status: AskStatus;
  created_at: number;
  poster_id: string;
  username: string;
  has_mandate: number;
  exclusivity: Exclusivity | null;
};

const CATEGORY_SLUGS = new Set<string>(CATEGORIES.map((c) => c.slug));
const STATUS_SET = new Set<string>(ASK_STATUSES);

function href(cat: string, status: string): string {
  const q = new URLSearchParams();
  if (cat) q.set("cat", cat);
  if (status) q.set("status", status);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

async function loadBoard(cat: string, status: string) {
  const db = await getDb();

  // Moderated asks vanish from the board and from every count on it.
  const notHidden = "id NOT IN (SELECT ask_id FROM hidden_asks)";
  const where: string[] = [`a.${notHidden}`];
  const args: string[] = [];
  if (cat) {
    where.push("a.category = ?");
    args.push(cat);
  }
  if (status) {
    where.push("a.status = ?");
    args.push(status);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const [rowsRs, catRs, statusRs, buyersRs] = await Promise.all([
    db.execute({
      sql: `SELECT a.id, a.title, a.category, a.modality_tags, a.volume,
                   a.price_band, a.supply_filled_pct, a.buyer_token,
                   a.buyer_is_other, a.status, a.created_at,
                   a.user_id AS poster_id, u.username,
                   EXISTS(SELECT 1 FROM ask_mandates m WHERE m.ask_id = a.id)
                     AS has_mandate,
                   t.exclusivity
              FROM asks a JOIN users u ON u.id = a.user_id
              LEFT JOIN ask_terms t ON t.ask_id = a.id
              ${whereSql}
             ORDER BY a.created_at DESC
             LIMIT 200`,
      args,
    }),
    db.execute(`SELECT category, COUNT(*) AS n FROM asks WHERE ${notHidden} GROUP BY category`),
    db.execute(`SELECT status, COUNT(*) AS n FROM asks WHERE ${notHidden} GROUP BY status`),
    db.execute(`SELECT COUNT(DISTINCT buyer_token) AS n FROM asks WHERE ${notHidden}`),
  ]);

  const asks: AskRow[] = rowsRs.rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    category: String(r.category),
    modality_tags: String(r.modality_tags),
    volume: String(r.volume),
    price_band: String(r.price_band),
    supply_filled_pct: Number(r.supply_filled_pct),
    buyer_token: String(r.buyer_token),
    buyer_is_other: Number(r.buyer_is_other),
    status: (STATUS_SET.has(String(r.status)) ? String(r.status) : "open") as AskStatus,
    created_at: Number(r.created_at),
    poster_id: String(r.poster_id),
    username: String(r.username),
    has_mandate: Number(r.has_mandate),
    exclusivity: isExclusivity(r.exclusivity) ? r.exclusivity : null,
  }));

  const catCounts = new Map(catRs.rows.map((r) => [String(r.category), Number(r.n)]));
  const statusCounts = new Map(statusRs.rows.map((r) => [String(r.status), Number(r.n)]));
  const total = [...statusCounts.values()].reduce((a, b) => a + b, 0);

  return {
    asks,
    catCounts,
    statusCounts,
    total,
    distinctBuyers: Number(buyersRs.rows[0]?.n ?? 0),
  };
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; status?: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <PageStub
        eyebrow="The board"
        title="Somebody wants your data."
        blurb="Public asks for training, eval and preference data, visible to signed-in members."
      >
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const sp = await searchParams;
  const cat = CATEGORY_SLUGS.has(sp.cat ?? "") ? (sp.cat as string) : "";
  const status = STATUS_SET.has(sp.status ?? "") ? (sp.status as string) : "";

  const board = await loadBoard(cat, status);
  const nowMs = Date.now();

  // Recorded-volume priority: look up each poster's confirmed co-attested
  // volume once, then reorder the already-fetched rows as a SECONDARY sort
  // after recency (comparePriority buckets recency and keeps it dominant, so a
  // record-empty poster still appears, just lower inside its own window). Exact
  // figures stay here; only the bucketed chip is ever rendered.
  const volumes = await recordedVolumeByUser([
    ...new Set(board.asks.map((a) => a.poster_id)),
  ]);
  const priorityOf = (a: AskRow) => ({
    createdAt: a.created_at,
    volumeUsd: volumes.get(a.poster_id)?.volumeUsd ?? 0,
    evidenceBackedDeals: volumes.get(a.poster_id)?.evidenceBackedDeals ?? 0,
  });
  const asks = [...board.asks].sort((a, b) =>
    comparePriority(priorityOf(a), priorityOf(b), nowMs),
  );

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-12">
      {/* ------------------------------------------------------- masthead */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div>
          <div className="bt-label">The board</div>
          <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
            Somebody wants your data.
          </h1>
          <p className="mt-4 max-w-[58ch] text-[0.9375rem] leading-relaxed text-ink-dim">
            Asks for training, eval and preference data. Posters are
            pseudonymous, buyers are four hex characters of a keyed hash, and
            nothing a broker would want out of this database is in it.
          </p>
        </div>

        <div className="flex items-stretch divide-x divide-rule border border-rule bg-panel">
          <Stat label="Asks" value={board.total} />
          <Stat label="Buyers" value={board.distinctBuyers} />
          <Stat label="Open" value={board.statusCounts.get("open") ?? 0} />
          <div className="flex items-center px-4">
            <Link href="/new" className="bt-btn bt-btn-primary px-4 py-2 text-[0.75rem]">
              Post an ask
            </Link>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------- filters */}
      <div className="mt-10 space-y-3 border-y border-rule py-4">
        <FilterRow label="Category">
          <FilterChip href={href("", status)} active={cat === ""}>
            all
          </FilterChip>
          {CATEGORIES.filter((c) => (board.catCounts.get(c.slug) ?? 0) > 0).map(
            (c) => (
              <FilterChip
                key={c.slug}
                href={href(c.slug, status)}
                active={cat === c.slug}
                count={board.catCounts.get(c.slug) ?? 0}
              >
                {c.label.toLowerCase()}
              </FilterChip>
            ),
          )}
        </FilterRow>
        <FilterRow label="Status">
          <FilterChip href={href(cat, "")} active={status === ""}>
            all
          </FilterChip>
          {ASK_STATUSES.map((s) => (
            <FilterChip
              key={s}
              href={href(cat, s)}
              active={status === s}
              count={board.statusCounts.get(s) ?? 0}
            >
              {s}
            </FilterChip>
          ))}
        </FilterRow>
      </div>

      {/* --------------------------------------------------------- ledger */}
      {asks.length === 0 ? (
        <div className="relative mt-8 overflow-hidden border border-rule bg-panel px-6 py-16 text-center">
          <div className="bt-hatch pointer-events-none absolute inset-0 opacity-40" />
          <div className="relative">
            <div className="bt-label text-ink-ghost">Nothing here</div>
            <p className="mx-auto mt-3 max-w-[44ch] text-[0.875rem] leading-relaxed text-ink-faint">
              No asks under these filters.{" "}
              <Link href="/" className="text-blue hover:text-amber">
                Clear them
              </Link>
              , or{" "}
              <Link href="/new" className="text-blue hover:text-amber">
                be the first to post
              </Link>
              .
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-8 border border-rule bg-panel">
          {/* column rail, desktop only */}
          <div className="hidden border-b border-rule-strong px-4 py-2.5 lg:grid lg:grid-cols-[minmax(0,1fr)_6.5rem_7rem_8rem_7rem_5rem] lg:gap-x-4">
            <span className="bt-label">Ask</span>
            <span className="bt-label">Volume</span>
            <span className="bt-label">Price band</span>
            <span className="bt-label">Supply filled</span>
            <span className="bt-label">Buyer</span>
            <span className="bt-label">Status</span>
          </div>

          <ul className="divide-y divide-rule">
            {asks.map((a) => {
              const closed = a.status === "closed";
              const trackChip = recordedVolumeChip(
                volumes.get(a.poster_id)?.volumeUsd ?? 0,
              );
              return (
                <li key={a.id} className="relative">
                  <Link
                    href={`/ask/${a.id}`}
                    className={[
                      "group relative grid gap-x-4 gap-y-2.5 px-4 py-4 transition-colors",
                      "lg:grid-cols-[minmax(0,1fr)_6.5rem_7rem_8rem_7rem_5rem] lg:items-center",
                      "hover:bg-panel-2",
                    ].join(" ")}
                  >
                    <div className="min-w-0">
                      <div
                        className={[
                          "truncate text-[0.9375rem] leading-snug transition-colors",
                          closed
                            ? "text-ink-dim"
                            : "text-ink group-hover:text-amber",
                        ].join(" ")}
                      >
                        {a.title}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <CategoryTag slug={a.category} dim={closed} />
                        <ModalityTags tags={unpackTags(a.modality_tags)} dim={closed} />
                        <TermsChip exclusivity={a.exclusivity} dim={closed} />
                        {a.has_mandate === 1 ? <MandateMark dim={closed} /> : null}
                        <TrackRecordChip chip={trackChip} dim={closed} />
                        <span className="font-mono text-[0.6875rem] text-ink-ghost">
                          @{a.username} · {timeAgo(a.created_at, nowMs)}
                        </span>
                      </div>
                    </div>

                    {/* desktop columns */}
                    <span className="hidden font-mono text-[0.75rem] text-ink-dim lg:block">
                      {a.volume || "·"}
                    </span>
                    <span className="hidden text-[0.75rem] text-ink-dim lg:block">
                      {a.price_band || "·"}
                    </span>
                    <span className="hidden lg:block">
                      <SupplyMeter pct={a.supply_filled_pct} dim={closed} />
                    </span>
                    <span className="hidden lg:block">
                      <BuyerChip
                        token={a.buyer_token}
                        isOther={a.buyer_is_other === 1}
                        dim={closed}
                      />
                    </span>
                    <span className="hidden lg:block">
                      <StatusMark status={a.status} />
                    </span>

                    {/* mobile summary line */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:hidden">
                      {a.volume ? (
                        <span className="font-mono text-[0.6875rem] text-ink-dim">
                          {a.volume}
                        </span>
                      ) : null}
                      {a.price_band ? (
                        <span className="text-[0.6875rem] text-ink-dim">
                          {a.price_band}
                        </span>
                      ) : null}
                      <SupplyMeter pct={a.supply_filled_pct} dim={closed} />
                      <BuyerChip
                        token={a.buyer_token}
                        isOther={a.buyer_is_other === 1}
                        dim={closed}
                      />
                      <StatusMark status={a.status} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="mt-6 text-[0.8125rem] text-ink-faint">
        Same four characters on two asks, same buyer. Who that buyer is never
        reaches the database.{" "}
        <Link href="/transparency" className="text-blue hover:text-amber">
          Read the schema
        </Link>
        .
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- fragments */

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-4 py-3">
      <div className="bt-label">{label}</div>
      <div className="mt-1.5 font-mono text-[1.375rem] leading-none tabular-nums text-amber">
        {value}
      </div>
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
      <span className="bt-label w-16 shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  href,
  active,
  count,
  children,
}: {
  href: string;
  active: boolean;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={[
        "inline-flex items-baseline gap-1.5 border px-2.5 py-1 font-mono text-[0.6875rem] transition-colors",
        active
          ? "border-ink bg-ink text-void"
          : "border-rule-strong bg-panel text-ink-faint hover:border-ink-ghost hover:text-ink-dim",
      ].join(" ")}
    >
      {children}
      {typeof count === "number" ? (
        <span className={active ? "text-void/70" : "text-ink-ghost"}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}
