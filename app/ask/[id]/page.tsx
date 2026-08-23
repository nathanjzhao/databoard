/**
 * /ask/[id]
 *
 * The full docket for one ask. Poster sees lifecycle controls (supply,
 * close) and the incoming collaboration requests; everyone else sees the
 * spec and a request-to-collaborate panel. The buyer stays four hex
 * characters here too, with one extra honesty: how many other asks on the
 * board point at the same token.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DbNotConfiguredNotice, PageStub } from "@/components/page-stub";
import { StatusMark } from "@/components/ask/meta";
import { timeAgo } from "@/components/ask/format";
import { CollabPanel } from "@/components/ask/collab-button";
import { OwnerControls } from "@/components/ask/owner-controls";
import { getSessionUser } from "@/lib/auth";
import { getDb, isDbConfigured } from "@/lib/db";
import { categoryLabel, unpackTags, type AskStatus } from "@/lib/taxonomy";

export const metadata: Metadata = { title: "Ask" };
export const dynamic = "force-dynamic";

type CollabStatus = "pending" | "accepted" | "declined" | "withdrawn";

type Ask = {
  id: string;
  user_id: string;
  title: string;
  category: string;
  description: string;
  modality_tags: string;
  volume: string;
  price_band: string;
  supply_filled_pct: number;
  buyer_token: string;
  buyer_is_other: number;
  status: AskStatus;
  created_at: number;
  username: string;
};

type IncomingRequest = {
  id: string;
  username: string;
  note: string;
  status: CollabStatus;
  created_at: number;
};

export default async function AskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <PageStub eyebrow="Ask" title="One ask, in full." blurb="">
        <DbNotConfiguredNotice />
      </PageStub>
    );
  }

  const user = await getSessionUser();
  if (!user) redirect("/gate");

  const { id } = await params;
  const db = await getDb();

  const askRs = await db.execute({
    sql: `SELECT a.*, u.username
            FROM asks a JOIN users u ON u.id = a.user_id
           WHERE a.id = ?`,
    args: [id],
  });
  const row = askRs.rows[0];
  if (!row) notFound();

  const ask: Ask = {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title),
    category: String(row.category),
    description: String(row.description),
    modality_tags: String(row.modality_tags),
    volume: String(row.volume),
    price_band: String(row.price_band),
    supply_filled_pct: Number(row.supply_filled_pct),
    buyer_token: String(row.buyer_token),
    buyer_is_other: Number(row.buyer_is_other),
    status: String(row.status) as AskStatus,
    created_at: Number(row.created_at),
    username: String(row.username),
  };

  const mine = ask.user_id === user.id;
  const closed = ask.status === "closed";

  const sameBuyerRs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM asks WHERE buyer_token = ? AND id != ?`,
    args: [ask.buyer_token, ask.id],
  });
  const sameBuyer = Number(sameBuyerRs.rows[0]?.n ?? 0);

  let incoming: IncomingRequest[] = [];
  let myRequest: CollabStatus | null = null;
  if (mine) {
    const rs = await db.execute({
      sql: `SELECT c.id, c.note, c.status, c.created_at, u.username
              FROM collab_requests c JOIN users u ON u.id = c.requester_id
             WHERE c.ask_id = ?
             ORDER BY c.created_at DESC`,
      args: [ask.id],
    });
    incoming = rs.rows.map((r) => ({
      id: String(r.id),
      username: String(r.username),
      note: String(r.note),
      status: String(r.status) as CollabStatus,
      created_at: Number(r.created_at),
    }));
  } else {
    const rs = await db.execute({
      sql: `SELECT status FROM collab_requests WHERE ask_id = ? AND requester_id = ?`,
      args: [ask.id, user.id],
    });
    myRequest = rs.rows[0] ? (String(rs.rows[0].status) as CollabStatus) : null;
  }

  const nowMs = Date.now();
  const tags = unpackTags(ask.modality_tags);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-12">
      {/* ----------------------------------------------------- breadcrumb */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[0.6875rem] text-ink-ghost">
        <Link href="/" className="text-ink-faint transition-colors hover:text-amber">
          board
        </Link>
        <span>/</span>
        <span>{ask.id}</span>
      </div>

      {/* ------------------------------------------------------- masthead */}
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <StatusMark status={ask.status} />
        <span className="text-[0.6875rem] uppercase tracking-[0.08em] text-ink-dim">
          {categoryLabel(ask.category)}
        </span>
        <span className="font-mono text-[0.6875rem] text-ink-ghost">
          posted {timeAgo(ask.created_at, nowMs)} by @{ask.username}
          {mine ? " (you)" : ""}
        </span>
      </div>

      <h1 className="bt-display mt-4 max-w-[26ch] text-[2.25rem] leading-[1.08] text-ink sm:text-[2.75rem]">
        {ask.title}
      </h1>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* --------------------------------------------------- main column */}
        <div className="min-w-0">
          {/* spec strip */}
          <div className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
            <SpecCell label="Volume" value={ask.volume || "unspecified"} mono />
            <SpecCell label="Price band" value={ask.price_band || "undisclosed"} />
            <SpecCell
              label="Modalities"
              value={tags.length > 0 ? tags.join(" · ") : "unspecified"}
              mono
            />
            <SpecCell
              label="Posted"
              value={new Date(ask.created_at).toISOString().slice(0, 10)}
              mono
            />
          </div>

          {/* supply, wide */}
          <div className="mt-6 border border-rule bg-panel px-5 py-4">
            <div className="flex items-baseline justify-between">
              <span className="bt-label">Supply filled</span>
              <span
                className={[
                  "font-mono text-[1.25rem] leading-none tabular-nums",
                  closed ? "text-ink-ghost" : "text-green",
                ].join(" ")}
              >
                {ask.supply_filled_pct}
                <span className="text-[0.75rem] text-ink-faint">%</span>
              </span>
            </div>
            <div className="mt-3 h-[6px] w-full bg-panel-3">
              <div
                className={closed ? "h-full bg-ink-ghost" : "h-full bg-green"}
                style={{ width: `${ask.supply_filled_pct}%` }}
              />
            </div>
            <p className="mt-2.5 text-[0.75rem] text-ink-faint">
              {closed
                ? "Closed. The meter is history now, not a request."
                : ask.supply_filled_pct === 0
                  ? "Nothing filled yet. The whole ask is on the table."
                  : `The remaining ${100 - ask.supply_filled_pct}% is what this ask is for.`}
            </p>
          </div>

          {/* description */}
          <div className="mt-8">
            <div className="bt-label">The ask, in the poster&apos;s words</div>
            {ask.description ? (
              <p className="mt-3 max-w-[68ch] whitespace-pre-line text-[0.9375rem] leading-relaxed text-ink-dim">
                {ask.description}
              </p>
            ) : (
              <p className="mt-3 text-[0.875rem] text-ink-ghost">
                No description. The title is the whole ask.
              </p>
            )}
          </div>
        </div>

        {/* ---------------------------------------------------- side rail */}
        <div className="space-y-6">
          {/* buyer */}
          <div className="border border-rule bg-panel">
            <div className="border-b border-rule px-5 py-3">
              <span className="bt-label">Buyer</span>
            </div>
            <div className="px-5 py-4">
              <div className="flex items-baseline gap-2.5">
                <span className="font-mono text-[1.75rem] leading-none text-amber">
                  #{ask.buyer_token.slice(0, 4)}
                </span>
                {ask.buyer_is_other === 1 ? (
                  <span className="font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-ink-faint">
                    off-list
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-[0.75rem] leading-relaxed text-ink-faint">
                {sameBuyer > 0 ? (
                  <>
                    The same token appears on{" "}
                    <span className="text-ink-dim">
                      {sameBuyer} other {sameBuyer === 1 ? "ask" : "asks"}
                    </span>{" "}
                    on this board.
                  </>
                ) : (
                  "No other ask on the board carries this token."
                )}{" "}
                Equality is visible; identity is not. The name behind it was
                keyed and discarded at posting time.
              </p>
              {ask.buyer_is_other === 1 ? (
                <p className="mt-2 border-l-2 border-rule pl-3 text-[0.75rem] leading-relaxed text-ink-faint">
                  Off-list: the poster typed this buyer rather than picking
                  from the shared dropdown, so the token may not line up with
                  anyone else&apos;s spelling.
                </p>
              ) : null}
            </div>
          </div>

          {/* lifecycle or collab */}
          {mine ? (
            <OwnerControls
              askId={ask.id}
              supplyFilledPct={ask.supply_filled_pct}
              status={ask.status}
            />
          ) : closed ? (
            <div className="relative overflow-hidden border border-rule bg-panel px-5 py-5">
              <div className="bt-hatch pointer-events-none absolute inset-0 opacity-40" />
              <div className="relative">
                <div className="bt-label text-ink-ghost">Closed</div>
                <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-faint">
                  This ask is not taking collaboration requests. It stays on
                  the board as a record.
                </p>
              </div>
            </div>
          ) : (
            <CollabPanel askId={ask.id} existingStatus={myRequest} />
          )}

          {/* incoming requests, owner only */}
          {mine ? (
            <div className="border border-rule bg-panel">
              <div className="flex items-baseline justify-between border-b border-rule px-5 py-3">
                <span className="bt-label">Collaboration requests</span>
                <span className="font-mono text-[0.6875rem] text-amber">
                  {incoming.length}
                </span>
              </div>
              {incoming.length === 0 ? (
                <p className="px-5 py-4 text-[0.8125rem] leading-relaxed text-ink-faint">
                  None yet. When someone claims to have some of this, their
                  username and note land here.
                </p>
              ) : (
                <ul className="divide-y divide-rule">
                  {incoming.map((r) => (
                    <li key={r.id} className="px-5 py-3.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="font-mono text-[0.75rem] text-ink">
                          @{r.username}
                        </span>
                        <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-ink-ghost">
                          {r.status} · {timeAgo(r.created_at, nowMs)}
                        </span>
                      </div>
                      {r.note ? (
                        <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-dim">
                          {r.note}
                        </p>
                      ) : (
                        <p className="mt-1.5 text-[0.75rem] text-ink-ghost">
                          No note.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-rule px-5 py-3">
                <p className="text-[0.6875rem] leading-relaxed text-ink-ghost">
                  Accepting and messaging happen under{" "}
                  <Link href="/matches" className="text-blue hover:text-amber">
                    Matches
                  </Link>{" "}
                  and{" "}
                  <Link href="/messages" className="text-blue hover:text-amber">
                    Messages
                  </Link>
                  .
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SpecCell({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="bt-label">{label}</div>
      <div
        className={[
          "mt-1.5 text-[0.8125rem] leading-snug text-ink-dim",
          mono ? "font-mono text-[0.75rem]" : "",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}
