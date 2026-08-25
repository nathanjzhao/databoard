/**
 * components/ask/related.tsx
 *
 * The "Related" section of an ask page. Three ways another record can be
 * related, each shown with exactly the information every member already has
 * access to elsewhere on the board:
 *
 *   * asks carrying the same blinded buyer token (equality is public,
 *     identity is not), open ones first, closed ones after;
 *   * asks with the same category and at least one shared modality tag,
 *     whoever the buyer is: the same shape of demand;
 *   * how many confirmed deals on the board name the same buyer. A count
 *     and nothing else: amounts stay on the deal pages, participants only.
 *     "Confirmed" means co-attested (lib/deals.ts): at least one named
 *     participant, none pending.
 *
 * Self-contained async server component: takes the ask row's public fields,
 * fetches its own rows, renders nothing when there is nothing related.
 * Hidden asks are invisible here like everywhere else.
 */

import Link from "next/link";
import { getDb } from "@/lib/db";
import { unpackTags } from "@/lib/taxonomy";
import { timeAgo } from "@/components/ask/format";

type RelatedAsk = {
  id: string;
  title: string;
  status: string;
  created_at: number;
};

const SAME_BUYER_LIMIT = 5;
const SAME_SHAPE_LIMIT = 4;

export async function RelatedSection({
  askId,
  buyerToken,
  category,
  tags,
}: {
  askId: string;
  buyerToken: string;
  category: string;
  tags: string[];
}) {
  const db = await getDb();

  const [sameBuyerRs, sameShapeRs, dealsRs] = await Promise.all([
    db.execute({
      sql: `SELECT id, title, status, created_at FROM asks
             WHERE buyer_token = ? AND id != ?
               AND id NOT IN (SELECT ask_id FROM hidden_asks)
             ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END,
                      created_at DESC
             LIMIT ?`,
      args: [buyerToken, askId, SAME_BUYER_LIMIT],
    }),
    db.execute({
      sql: `SELECT id, title, status, created_at, modality_tags FROM asks
             WHERE category = ? AND id != ? AND buyer_token != ?
               AND id NOT IN (SELECT ask_id FROM hidden_asks)
             ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END,
                      created_at DESC
             LIMIT 60`,
      args: [category, askId, buyerToken],
    }),
    db.execute({
      // Co-attested: >=1 named participant, none pending. Count only.
      sql: `SELECT COUNT(*) AS n FROM deals d
             WHERE d.buyer_token = ?
               AND EXISTS (SELECT 1 FROM deal_participants pc
                            WHERE pc.deal_id = d.id AND pc.role = 'participant'
                              AND pc.status = 'confirmed')
               AND NOT EXISTS (SELECT 1 FROM deal_participants pp
                                WHERE pp.deal_id = d.id AND pp.role = 'participant'
                                  AND pp.status = 'pending')`,
      args: [buyerToken],
    }),
  ]);

  const sameBuyer: RelatedAsk[] = sameBuyerRs.rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    status: String(r.status),
    created_at: Number(r.created_at),
  }));

  // Shape match needs a shared tag, computed here: the tag list is a packed
  // string and SQL substring matching would confuse "3d" with "d".
  const want = new Set(tags);
  const sameShape: RelatedAsk[] =
    want.size === 0
      ? []
      : sameShapeRs.rows
          .filter((r) =>
            unpackTags(String(r.modality_tags)).some((t) => want.has(t)),
          )
          .slice(0, SAME_SHAPE_LIMIT)
          .map((r) => ({
            id: String(r.id),
            title: String(r.title),
            status: String(r.status),
            created_at: Number(r.created_at),
          }));

  const sameBuyerDeals = Number(dealsRs.rows[0]?.n ?? 0);

  if (sameBuyer.length === 0 && sameShape.length === 0 && sameBuyerDeals === 0) {
    return null;
  }

  const nowMs = Date.now();

  return (
    <div className="mt-10 border-t border-rule pt-8">
      <div className="bt-label">Related</div>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        {sameBuyer.length > 0 ? (
          <RelatedList
            heading="Same buyer token"
            items={sameBuyer}
            nowMs={nowMs}
          />
        ) : null}
        {sameShape.length > 0 ? (
          <RelatedList
            heading="Same category and modality"
            items={sameShape}
            nowMs={nowMs}
          />
        ) : null}
      </div>
      {sameBuyerDeals > 0 ? (
        <p className="mt-5 text-[0.8125rem] text-ink-faint">
          <span className="font-mono text-ink-dim">{sameBuyerDeals}</span>{" "}
          confirmed {sameBuyerDeals === 1 ? "deal" : "deals"} on this board{" "}
          {sameBuyerDeals === 1 ? "names" : "name"} the same buyer. Count
          only; amounts stay with the deals&apos; own participants.
        </p>
      ) : null}
    </div>
  );
}

function RelatedList({
  heading,
  items,
  nowMs,
}: {
  heading: string;
  items: RelatedAsk[];
  nowMs: number;
}) {
  return (
    <div className="border border-rule bg-panel">
      <div className="border-b border-rule px-4 py-2.5">
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-ink-faint">
          {heading}
        </span>
      </div>
      <ul className="divide-y divide-rule">
        {items.map((a) => {
          const closed = a.status === "closed";
          return (
            <li key={a.id}>
              <Link
                href={`/ask/${a.id}`}
                className="group flex items-baseline justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-panel-2"
              >
                <span
                  className={[
                    "min-w-0 truncate text-[0.8125rem] leading-snug",
                    closed
                      ? "text-ink-faint"
                      : "text-ink-dim group-hover:text-amber",
                  ].join(" ")}
                >
                  {a.title}
                </span>
                <span className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-ink-ghost">
                  {closed ? "closed" : timeAgo(a.created_at, nowMs)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
