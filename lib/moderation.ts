/**
 * lib/moderation.ts
 *
 * The operator flag and the hide/unhide lifecycle for asks. Server-only.
 *
 * Moderation here is one verb: hide. A hidden ask disappears from the board,
 * from buyer matching and from everyone else's ask page; the poster keeps
 * their own page with a banner naming the reason, and an operator can unhide.
 * Nothing is deleted, so an unhide restores exactly what was there.
 *
 * No PII moves through this module: operators are user ids (which resolve to
 * handles and nothing else), and the reason is operator-written free text.
 * The UI tells operators not to quote contact details or names in it; this
 * module stores what they typed, verbatim, where the poster can read it.
 */

import { getDb, now } from "./db.ts";

export const MAX_HIDE_REASON_LENGTH = 500;

/** Whether this account holds the operator flag. False for null-ish ids. */
export async function isOperator(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT 1 FROM operators WHERE user_id = ?`,
    args: [userId],
  });
  return rs.rows.length > 0;
}

/** The moderation state of one ask, or null when it is not hidden. */
export type HiddenInfo = { reason: string; hiddenAt: number; hiddenBy: string };

export async function getHiddenInfo(askId: string): Promise<HiddenInfo | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT reason, hidden_at, hidden_by FROM hidden_asks WHERE ask_id = ?`,
    args: [askId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return {
    reason: String(row.reason),
    hiddenAt: Number(row.hidden_at),
    hiddenBy: String(row.hidden_by),
  };
}

export type HideResult =
  | { ok: true }
  | { ok: false; error: "not_operator" | "not_found" | "bad_reason" | "already_hidden" };

/**
 * Hide an ask. Operator-only, reason required. The reason is shown verbatim
 * to the poster and on /admin, so callers surface the no-PII rule before the
 * text is typed. Hiding an already-hidden ask is refused rather than
 * silently rewriting the first operator's reason.
 */
export async function hideAsk(
  operatorId: string,
  askId: string,
  reason: string,
): Promise<HideResult> {
  if (!(await isOperator(operatorId))) return { ok: false, error: "not_operator" };

  const trimmed = (reason ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HIDE_REASON_LENGTH) {
    return { ok: false, error: "bad_reason" };
  }

  const db = await getDb();
  const askRs = await db.execute({ sql: `SELECT 1 FROM asks WHERE id = ?`, args: [askId] });
  if (askRs.rows.length === 0) return { ok: false, error: "not_found" };

  try {
    await db.execute({
      sql: `INSERT INTO hidden_asks (ask_id, hidden_by, reason, hidden_at)
            VALUES (?, ?, ?, ?)`,
      args: [askId, operatorId, trimmed, now()],
    });
  } catch (err) {
    // PRIMARY KEY collision: someone hid it first. Their reason stands.
    if (String(err).includes("hidden_asks")) return { ok: false, error: "already_hidden" };
    throw err;
  }
  return { ok: true };
}

export type UnhideResult =
  | { ok: true }
  | { ok: false; error: "not_operator" | "not_hidden" };

/** Remove the hide. Operator-only. A no-op unhide reports not_hidden. */
export async function unhideAsk(operatorId: string, askId: string): Promise<UnhideResult> {
  if (!(await isOperator(operatorId))) return { ok: false, error: "not_operator" };
  const db = await getDb();
  const rs = await db.execute({
    sql: `DELETE FROM hidden_asks WHERE ask_id = ?`,
    args: [askId],
  });
  if (rs.rowsAffected === 0) return { ok: false, error: "not_hidden" };
  return { ok: true };
}

/** One row on the /admin hidden list. Handles only, per the schema's rules. */
export type HiddenAsk = {
  askId: string;
  title: string;
  posterUsername: string;
  reason: string;
  hiddenAt: number;
  hiddenByUsername: string;
};

/**
 * Every currently hidden ask, newest hide first, for /admin. hidden_by is a
 * plain user id column (no FK), so the operator handle join is LEFT: a
 * departed operator renders as "gone", not as a missing row.
 */
export async function listHidden(): Promise<HiddenAsk[]> {
  const db = await getDb();
  const rs = await db.execute(
    `SELECT h.ask_id, h.reason, h.hidden_at,
            a.title, pu.username AS poster_username,
            ou.username AS operator_username
       FROM hidden_asks h
       JOIN asks a   ON a.id  = h.ask_id
       JOIN users pu ON pu.id = a.user_id
  LEFT JOIN users ou ON ou.id = h.hidden_by
      ORDER BY h.hidden_at DESC`,
  );
  return rs.rows.map((r) => ({
    askId: String(r.ask_id),
    title: String(r.title),
    posterUsername: String(r.poster_username),
    reason: String(r.reason),
    hiddenAt: Number(r.hidden_at),
    hiddenByUsername: r.operator_username == null ? "gone" : String(r.operator_username),
  }));
}
