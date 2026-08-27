/**
 * lib/autoclose.ts
 *
 * The stale-ask clock. Server-only, async, raw SQL against ask_activity and
 * ask_closures (db/schema.sql).
 *
 * The rule, in one sentence: an open or partial ask whose last affirmation
 * is more than 7 days old closes automatically, and the closure is recorded
 * with reason 'auto_stale' so the ask page can say exactly what happened.
 *
 * What counts as an affirmation:
 *   * posting the ask (creation seeds ask_activity at the posting time),
 *   * the owner moving the supply meter,
 *   * the owner pressing "Still ongoing" (optionally with a short note,
 *     shown on the ask page as the last update),
 *   * a deal linked to the ask reaching co-attested: every non-declined
 *     named participant confirmed. lib/deals.ts writes ask_activity the
 *     moment the last participant settles, and the sweep below ALSO reads
 *     deal_participants directly at close time, so settles from before that
 *     write existed still count.
 *
 * Asks from before ask_activity existed have no row; their created_at is
 * the honest fallback, which means the first autoclose pass sweeps genuinely
 * abandoned pre-feature asks instead of grandfathering them forever.
 */

import { getDb, now } from "./db.ts";
import { appendLeafBestEffort } from "./translog.ts";

/** 7 days without an affirmation and an ask is stale. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The owner countdown appears once less than this remains. */
export const AUTOCLOSE_WARN_MS = 3 * 24 * 60 * 60 * 1000;

export type AskActivity = { affirmedAt: number; note: string };
export type ClosureReason = "auto_stale" | "owner";
export type AskClosure = { reason: ClosureReason; closedAt: number };

/**
 * A deal is co-attested when it has at least one named participant, none
 * pending, at least one confirmed (lib/deals.ts deriveTier). This fragment
 * matches deals linked to the outer ask whose latest participant
 * confirmation is fresh enough; parameterized on the cutoff timestamp.
 */
const FRESH_COATTESTED_DEAL_SQL = `
  SELECT 1 FROM deals d
   WHERE d.ask_id = a.id
     AND NOT EXISTS (SELECT 1 FROM deal_participants pp
                      WHERE pp.deal_id = d.id AND pp.role = 'participant'
                        AND pp.status = 'pending')
     AND EXISTS (SELECT 1 FROM deal_participants pc
                  WHERE pc.deal_id = d.id AND pc.role = 'participant'
                    AND pc.status = 'confirmed' AND pc.confirmed_at >= ?)`;

/**
 * Refresh an ask's affirmation clock. A non-empty note replaces the stored
 * one (it is "the last update"); an empty or absent note leaves the previous
 * note standing, so a plain supply nudge does not erase what the poster
 * last wrote.
 */
export async function touchAskActivity(askId: string, note?: string): Promise<void> {
  const db = await getDb();
  const trimmed = (note ?? "").trim();
  await db.execute({
    sql: `INSERT INTO ask_activity (ask_id, affirmed_at, note)
          VALUES (?, ?, ?)
          ON CONFLICT (ask_id) DO UPDATE SET
            affirmed_at = excluded.affirmed_at,
            note = CASE WHEN excluded.note != '' THEN excluded.note
                        ELSE ask_activity.note END`,
    args: [askId, now(), trimmed],
  });
}

export async function getAskActivity(askId: string): Promise<AskActivity | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT affirmed_at, note FROM ask_activity WHERE ask_id = ?`,
    args: [askId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return { affirmedAt: Number(row.affirmed_at), note: String(row.note ?? "") };
}

export async function getAskClosure(askId: string): Promise<AskClosure | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT reason, closed_at FROM ask_closures WHERE ask_id = ?`,
    args: [askId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return {
    reason: String(row.reason) === "auto_stale" ? "auto_stale" : "owner",
    closedAt: Number(row.closed_at),
  };
}

/**
 * Record why an ask closed. First writer wins: a closure that already
 * happened is history, not something a later pass may rewrite.
 */
export async function recordAskClosure(
  askId: string,
  reason: ClosureReason,
): Promise<void> {
  const db = await getDb();
  const res = await db.execute({
    sql: `INSERT INTO ask_closures (ask_id, reason, closed_at)
          VALUES (?, ?, ?)
          ON CONFLICT (ask_id) DO NOTHING`,
    args: [askId, reason, now()],
  });
  // Only the first writer's closure is real (ON CONFLICT DO NOTHING); log the
  // ask_closed leaf just once, keyed on the ask so the auto and owner paths
  // never double-log. Best-effort: a log hiccup must not un-close an ask.
  if (res.rowsAffected > 0) {
    await appendLeafBestEffort(
      { type: "ask_closed", subject: askId, reason },
      { dedupKey: `ask_closed:${askId}` },
    );
  }
}

/**
 * The timestamp the autoclose clock actually runs against for one ask:
 * the ask_activity affirmation (falling back to created_at for pre-feature
 * rows), or the latest participant confirmation on a linked co-attested
 * deal, whichever is later. Drives the owner-facing countdown, so it must
 * agree with the SQL in runAutoclose below.
 */
export async function effectiveAffirmedAt(
  askId: string,
  createdAt: number,
): Promise<number> {
  const db = await getDb();
  const [act, dealRs] = await Promise.all([
    getAskActivity(askId),
    db.execute({
      sql: `SELECT MAX(pc.confirmed_at) AS t
              FROM deals d
              JOIN deal_participants pc ON pc.deal_id = d.id
             WHERE d.ask_id = ? AND pc.role = 'participant'
               AND pc.status = 'confirmed'
               AND NOT EXISTS (SELECT 1 FROM deal_participants pp
                                WHERE pp.deal_id = d.id
                                  AND pp.role = 'participant'
                                  AND pp.status = 'pending')`,
      args: [askId],
    }),
  ]);
  const dealT = Number(dealRs.rows[0]?.t ?? 0) || 0;
  return Math.max(act?.affirmedAt ?? createdAt, dealT);
}

/**
 * One autoclose pass: find every open or partial ask whose effective
 * affirmation predates the cutoff, close it, and record the closure as
 * 'auto_stale'. Idempotent (a closed ask never matches again) and safe to
 * run as often as the cron cares to. Returns what it closed.
 */
export async function runAutoclose(
  nowMs: number = now(),
): Promise<{ closed: number; askIds: string[] }> {
  const db = await getDb();
  const cutoff = nowMs - STALE_AFTER_MS;

  const staleRs = await db.execute({
    sql: `SELECT a.id
            FROM asks a
            LEFT JOIN ask_activity act ON act.ask_id = a.id
           WHERE a.status IN ('open', 'partial')
             AND COALESCE(act.affirmed_at, a.created_at) < ?
             AND NOT EXISTS (${FRESH_COATTESTED_DEAL_SQL})`,
    args: [cutoff, cutoff],
  });
  const askIds = staleRs.rows.map((r) => String(r.id));
  if (askIds.length === 0) return { closed: 0, askIds: [] };

  const t = now();
  const statements = askIds.flatMap((id) => [
    { sql: `UPDATE asks SET status = 'closed' WHERE id = ?`, args: [id] },
    {
      sql: `INSERT INTO ask_closures (ask_id, reason, closed_at)
            VALUES (?, 'auto_stale', ?)
            ON CONFLICT (ask_id) DO NOTHING`,
      args: [id, t] as (string | number)[],
    },
  ]);
  await db.batch(statements, "write");
  // Transparency log: one ask_closed leaf per newly-closed ask, keyed on the
  // ask so a re-run of the sweep never double-logs. Best-effort follow-on.
  for (const id of askIds) {
    await appendLeafBestEffort(
      { type: "ask_closed", subject: id, reason: "auto_stale" },
      { dedupKey: `ask_closed:${id}` },
    );
  }
  return { closed: askIds.length, askIds };
}
