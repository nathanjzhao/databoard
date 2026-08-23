/**
 * app/api/threads/store.ts
 *
 * Every query the messaging feature runs, in one place: the /messages pages
 * and the /api/threads and /api/messages route handlers all call through
 * here. Threads themselves are CREATED elsewhere (accepting a collab request
 * is the only door in); this module only reads them and appends to them.
 *
 * Authorization lives here, not in the callers: every function takes the
 * caller's user id and answers "no such thread" for a thread the caller is
 * not in, so route handlers cannot forget the check and nothing leaks
 * whether a thread id exists.
 *
 * Imports are relative with explicit .ts extensions (matching lib/*) so a
 * plain node script can drive these functions directly, the way
 * scripts/seed.ts drives lib/auth.ts.
 */

import { getDb, now } from "../../../lib/db.ts";
import { newId } from "../../../lib/crypto.ts";
import {
  MAX_MESSAGE_LENGTH,
  type ThreadDetail,
  type ThreadSummary,
  type WireMessage,
} from "../../../components/messages/types.ts";

/* ------------------------------------------------------------ thread list */

/**
 * All threads the user participates in, newest activity first. One SQL round
 * trip: the preview, the other participants and the unread flag come back as
 * correlated subqueries rather than N+1 queries per row.
 */
export async function listThreadsFor(userId: string): Promise<ThreadSummary[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `
      SELECT
        t.id                                   AS id,
        t.subject                              AS subject,
        t.ask_id                               AS ask_id,
        a.title                                AS ask_title,
        MAX(t.last_message_at, t.created_at)   AS last_at,
        (SELECT GROUP_CONCAT(u.username, ',')
           FROM thread_participants p
           JOIN users u ON u.id = p.user_id
          WHERE p.thread_id = t.id AND p.user_id <> me.user_id) AS others,
        (SELECT d.id FROM deals d
          WHERE d.thread_id = t.id
          ORDER BY d.created_at DESC, d.id DESC LIMIT 1)        AS deal_id,
        (SELECT m.body FROM messages m
          WHERE m.thread_id = t.id
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1)        AS last_body,
        (SELECT u.username FROM messages m
           JOIN users u ON u.id = m.sender_id
          WHERE m.thread_id = t.id
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1)        AS last_sender,
        EXISTS (SELECT 1 FROM messages m
                 WHERE m.thread_id = t.id
                   AND m.created_at > me.last_read_at
                   AND m.sender_id <> me.user_id)               AS unread
      FROM thread_participants me
      JOIN threads t   ON t.id = me.thread_id
      LEFT JOIN asks a ON a.id = t.ask_id
      WHERE me.user_id = ?
      ORDER BY last_at DESC`,
    args: [userId],
  });

  return rs.rows.map((row) => ({
    id: String(row.id),
    subject: String(row.subject ?? ""),
    askId: row.ask_id == null ? null : String(row.ask_id),
    askTitle: row.ask_title == null ? null : String(row.ask_title),
    others: row.others == null ? [] : String(row.others).split(",").filter(Boolean),
    dealId: row.deal_id == null ? null : String(row.deal_id),
    lastBody: row.last_body == null ? null : String(row.last_body),
    lastSender: row.last_sender == null ? null : String(row.last_sender),
    lastAt: Number(row.last_at),
    unread: Number(row.unread) === 1,
  }));
}

/* ------------------------------------------------------------ thread view */

/**
 * One thread with its messages, or null when the thread does not exist OR
 * the caller is not a participant (deliberately the same answer). Messages
 * with created_at >= `since` are returned, oldest first, so the poller can
 * pass its high-water mark and the client dedupes by id; `since` 0 means
 * everything.
 *
 * Fetching the thread is what marks it read: the caller is looking at it.
 */
export async function loadThread(
  threadId: string,
  userId: string,
  since = 0,
): Promise<ThreadDetail | null> {
  const db = await getDb();
  const fetchedAt = now();

  const membership = await db.execute({
    sql: `SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?`,
    args: [threadId, userId],
  });
  if (membership.rows.length === 0) return null;

  const [threadRs, othersRs, messagesRs] = await Promise.all([
    db.execute({
      sql: `SELECT t.id, t.subject, t.ask_id, a.title AS ask_title,
                   (SELECT d.id FROM deals d
                     WHERE d.thread_id = t.id
                     ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS deal_id
              FROM threads t
              LEFT JOIN asks a ON a.id = t.ask_id
             WHERE t.id = ?`,
      args: [threadId],
    }),
    db.execute({
      sql: `SELECT u.username
              FROM thread_participants p
              JOIN users u ON u.id = p.user_id
             WHERE p.thread_id = ? AND p.user_id <> ?
             ORDER BY u.username`,
      args: [threadId, userId],
    }),
    db.execute({
      sql: `SELECT m.id, m.body, m.created_at, m.sender_id, u.username
              FROM messages m
              JOIN users u ON u.id = m.sender_id
             WHERE m.thread_id = ? AND m.created_at >= ?
             ORDER BY m.created_at ASC, m.id ASC`,
      args: [threadId, since > 0 ? since : 0],
    }),
  ]);

  const threadRow = threadRs.rows[0];
  if (!threadRow) return null;

  // Looking at the thread is what "read" means here. No receipt is sent to
  // the other side; last_read_at only drives the viewer's own unread dot.
  await db.execute({
    sql: `UPDATE thread_participants SET last_read_at = ? WHERE thread_id = ? AND user_id = ?`,
    args: [fetchedAt, threadId, userId],
  });

  const messages: WireMessage[] = messagesRs.rows.map((m) => ({
    id: String(m.id),
    sender: String(m.username),
    mine: String(m.sender_id) === userId,
    body: String(m.body),
    createdAt: Number(m.created_at),
  }));

  return {
    id: String(threadRow.id),
    subject: String(threadRow.subject ?? ""),
    askId: threadRow.ask_id == null ? null : String(threadRow.ask_id),
    askTitle: threadRow.ask_title == null ? null : String(threadRow.ask_title),
    others: othersRs.rows.map((r) => String(r.username)),
    dealId: threadRow.deal_id == null ? null : String(threadRow.deal_id),
    messages,
    fetchedAt,
  };
}

/* --------------------------------------------------------------- sending */

export type AppendMessageResult =
  | { ok: true; message: WireMessage }
  | { ok: false; error: "not_participant" | "empty" | "too_long" };

/**
 * Appends one plain-text message. The sender must be a participant; a
 * non-participant (or a nonexistent thread) gets the same refusal. Bumps the
 * thread's last_message_at and the sender's own read cursor so their just
 * sent message never shows up as unread to them.
 */
export async function appendMessage(
  threadId: string,
  senderId: string,
  rawBody: string,
): Promise<AppendMessageResult> {
  const body = (rawBody ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "empty" };
  if (body.length > MAX_MESSAGE_LENGTH) return { ok: false, error: "too_long" };

  const db = await getDb();
  const membership = await db.execute({
    sql: `SELECT u.username
            FROM thread_participants p
            JOIN users u ON u.id = p.user_id
           WHERE p.thread_id = ? AND p.user_id = ?`,
    args: [threadId, senderId],
  });
  const memberRow = membership.rows[0];
  if (!memberRow) return { ok: false, error: "not_participant" };

  const id = newId("msg");
  const createdAt = now();

  await db.batch(
    [
      {
        sql: `INSERT INTO messages (id, thread_id, sender_id, body, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [id, threadId, senderId, body, createdAt],
      },
      {
        sql: `UPDATE threads SET last_message_at = ? WHERE id = ?`,
        args: [createdAt, threadId],
      },
      {
        sql: `UPDATE thread_participants SET last_read_at = ?
               WHERE thread_id = ? AND user_id = ?`,
        args: [createdAt, threadId, senderId],
      },
    ],
    "write",
  );

  return {
    ok: true,
    message: {
      id,
      sender: String(memberRow.username),
      mine: true,
      body,
      createdAt,
    },
  };
}
