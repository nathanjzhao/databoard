/**
 * app/api/threads/store.ts
 *
 * Every query the messaging feature runs, in one place: the /messages pages
 * and the /api/threads and /api/messages route handlers all call through
 * here. Threads themselves are CREATED elsewhere (accepting a collab request
 * and recording a deal are the only doors in); this module reads them,
 * appends to them, and installs their encryption keys.
 *
 * Authorization lives here, not in the callers: every function takes the
 * caller's user id and answers "no such thread" for a thread the caller is
 * not in, so route handlers cannot forget the check and nothing leaks
 * whether a thread id exists.
 *
 * Encryption posture, enforced server-side where it can be enforced:
 *   - A thread with thread_keys rows accepts ONLY envelope-shaped bodies
 *     (lib/e2ee.ts isEnvelope), so plaintext can never leak into an
 *     encrypted thread's history, even from a broken client.
 *   - thread_keys rows are written once, all seats in a single transaction,
 *     first writer wins, never updated. Replacing a wrap after the fact is
 *     what a key-substitution attack looks like, so the API has no verb
 *     for it.
 *   - What the server cannot enforce, it does not claim: it cannot verify
 *     that uploaded wraps decrypt to anything. A participant uploading
 *     garbage denies service to that one thread, visibly, and is a person
 *     the others are already talking to.
 *
 * Imports are relative with explicit .ts extensions (matching lib/*) so a
 * plain node script can drive these functions directly, the way
 * scripts/seed.ts drives lib/auth.ts.
 */

import { getDb, now } from "../../../lib/db.ts";
import { newId } from "../../../lib/crypto.ts";
import {
  isEnvelope,
  PUBKEY_B64_LEN,
  WRAPPED_KEY_B64_LEN,
} from "../../../lib/e2ee.ts";
import {
  MAX_CIPHERTEXT_LENGTH,
  MAX_MESSAGE_LENGTH,
  type ParticipantKey,
  type ThreadDetail,
  type ThreadSummary,
  type WireMessage,
} from "../../../components/messages/types.ts";

/* ------------------------------------------------------------ thread list */

/**
 * All threads the user participates in, newest activity first. One SQL round
 * trip: the preview, the other participants, the unread flag and the
 * viewer's wrapped thread key come back as correlated subqueries rather
 * than N+1 queries per row.
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
                   AND m.sender_id <> me.user_id)               AS unread,
        EXISTS (SELECT 1 FROM thread_keys k
                 WHERE k.thread_id = t.id)                      AS encrypted,
        (SELECT k.wrapped_key FROM thread_keys k
          WHERE k.thread_id = t.id AND k.user_id = me.user_id)  AS wrapped_key,
        (SELECT k.eph_pubkey FROM thread_keys k
          WHERE k.thread_id = t.id AND k.user_id = me.user_id)  AS eph_pubkey
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
    encrypted: Number(row.encrypted) === 1,
    wrappedKey: row.wrapped_key == null ? null : String(row.wrapped_key),
    ephPubkey: row.eph_pubkey == null ? null : String(row.eph_pubkey),
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
 * The encryption block rides along on every load: whether keys exist, the
 * caller's own wrapped key, and every seat's public key, which is what the
 * first client to open a keyless thread needs to set encryption up.
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

  const [threadRs, othersRs, messagesRs, keyRs, seatRs] = await Promise.all([
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
    db.execute({
      sql: `SELECT wrapped_key, eph_pubkey FROM thread_keys
             WHERE thread_id = ? AND user_id = ?`,
      args: [threadId, userId],
    }),
    db.execute({
      sql: `SELECT u.username, k.pubkey,
                   EXISTS (SELECT 1 FROM thread_keys tk
                            WHERE tk.thread_id = p.thread_id) AS keys_exist
              FROM thread_participants p
              JOIN users u ON u.id = p.user_id
              LEFT JOIN user_e2ee_keys k ON k.user_id = p.user_id
             WHERE p.thread_id = ?
             ORDER BY u.username`,
      args: [threadId],
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

  const myKeyRow = keyRs.rows[0];
  const participants: ParticipantKey[] = seatRs.rows.map((r) => ({
    username: String(r.username),
    pubkey: r.pubkey == null ? null : String(r.pubkey),
  }));
  const keysExist =
    seatRs.rows.length > 0 && Number(seatRs.rows[0].keys_exist) === 1;

  return {
    id: String(threadRow.id),
    subject: String(threadRow.subject ?? ""),
    askId: threadRow.ask_id == null ? null : String(threadRow.ask_id),
    askTitle: threadRow.ask_title == null ? null : String(threadRow.ask_title),
    others: othersRs.rows.map((r) => String(r.username)),
    dealId: threadRow.deal_id == null ? null : String(threadRow.deal_id),
    messages,
    fetchedAt,
    encryption: {
      keysExist,
      myWrappedKey: myKeyRow ? String(myKeyRow.wrapped_key) : null,
      myEphPubkey: myKeyRow ? String(myKeyRow.eph_pubkey) : null,
      participants,
    },
  };
}

/* ------------------------------------------------------------ key install */

export type InstallKeysResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "not_participant"
        | "already_set"
        | "missing_pubkeys"
        | "bad_entries";
    };

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Install the wrapped thread key for every seat, exactly once per thread.
 * The caller is the first participant whose client opened the thread: it
 * generated the random thread key, wrapped it for each participant's
 * registered public key, and posts the whole set here.
 *
 * Refusals, in order of what they defend:
 *   - non-participants cannot install anything ("no such thread");
 *   - a thread with any seat lacking a public key stays plaintext (the
 *     client should not have tried; the thread is honestly unencryptable);
 *   - the entry set must cover the participant set exactly, one wrap per
 *     seat, well-formed base64url of the right sizes;
 *   - and the write is first-wins inside a transaction: a concurrent
 *     install by another participant leaves exactly one winner, and the
 *     loser refetches and unwraps the winner's key.
 */
export async function installThreadKeys(
  threadId: string,
  callerId: string,
  entries: { username: string; wrappedKey: string; ephPubkey: string }[],
): Promise<InstallKeysResult> {
  const db = await getDb();

  const seats = await db.execute({
    sql: `SELECT p.user_id, u.username, k.pubkey
            FROM thread_participants p
            JOIN users u ON u.id = p.user_id
            LEFT JOIN user_e2ee_keys k ON k.user_id = p.user_id
           WHERE p.thread_id = ?`,
    args: [threadId],
  });
  const seatRows = seats.rows.map((r) => ({
    userId: String(r.user_id),
    username: String(r.username),
    pubkey: r.pubkey == null ? null : String(r.pubkey),
  }));

  if (!seatRows.some((s) => s.userId === callerId)) {
    return { ok: false, error: "not_participant" };
  }
  if (seatRows.some((s) => s.pubkey === null)) {
    return { ok: false, error: "missing_pubkeys" };
  }

  // Exactly one well-formed wrap per seat, no extras, no misses.
  const byUsername = new Map<string, { wrappedKey: string; ephPubkey: string }>();
  for (const e of entries ?? []) {
    const username = String(e?.username ?? "");
    const wrappedKey = String(e?.wrappedKey ?? "");
    const ephPubkey = String(e?.ephPubkey ?? "");
    if (
      wrappedKey.length !== WRAPPED_KEY_B64_LEN ||
      ephPubkey.length !== PUBKEY_B64_LEN ||
      !B64URL_RE.test(wrappedKey) ||
      !B64URL_RE.test(ephPubkey) ||
      byUsername.has(username)
    ) {
      return { ok: false, error: "bad_entries" };
    }
    byUsername.set(username, { wrappedKey, ephPubkey });
  }
  if (byUsername.size !== seatRows.length) return { ok: false, error: "bad_entries" };
  for (const s of seatRows) {
    if (!byUsername.has(s.username)) return { ok: false, error: "bad_entries" };
  }

  const t = now();
  const tx = await db.transaction("write");
  try {
    const existing = await tx.execute({
      sql: `SELECT 1 FROM thread_keys WHERE thread_id = ? LIMIT 1`,
      args: [threadId],
    });
    if (existing.rows.length > 0) {
      await tx.rollback();
      return { ok: false, error: "already_set" };
    }
    for (const s of seatRows) {
      const e = byUsername.get(s.username)!;
      await tx.execute({
        sql: `INSERT INTO thread_keys (thread_id, user_id, wrapped_key, eph_pubkey, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [threadId, s.userId, e.wrappedKey, e.ephPubkey, t],
      });
    }
    await tx.commit();
  } catch (err) {
    // A concurrent winner hits the PRIMARY KEY; anything else propagates.
    if (String(err).includes("thread_keys")) {
      return { ok: false, error: "already_set" };
    }
    throw err;
  } finally {
    tx.close();
  }
  return { ok: true };
}

/* --------------------------------------------------------------- sending */

export type AppendMessageResult =
  | { ok: true; message: WireMessage }
  | {
      ok: false;
      error: "not_participant" | "empty" | "too_long" | "encryption_required";
    };

/**
 * Appends one message. The sender must be a participant; a non-participant
 * (or a nonexistent thread) gets the same refusal.
 *
 * The body is either an encrypted envelope (lib/e2ee.ts) or plaintext, and
 * the thread's key state decides which is legal: a thread with installed
 * keys REFUSES plaintext, so the database can never accumulate readable
 * text in an encrypted thread, no matter what a client sends. Threads
 * without keys (legacy threads, or a seat without a registered key) accept
 * plaintext and are labeled as unencrypted in the UI.
 *
 * Bumps the thread's last_message_at and the sender's own read cursor so
 * their just-sent message never shows up as unread to them.
 */
export async function appendMessage(
  threadId: string,
  senderId: string,
  rawBody: string,
): Promise<AppendMessageResult> {
  const body = (rawBody ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "empty" };

  const db = await getDb();
  const membership = await db.execute({
    sql: `SELECT u.username,
                 EXISTS (SELECT 1 FROM thread_keys k
                          WHERE k.thread_id = p.thread_id) AS keys_exist
            FROM thread_participants p
            JOIN users u ON u.id = p.user_id
           WHERE p.thread_id = ? AND p.user_id = ?`,
    args: [threadId, senderId],
  });
  const memberRow = membership.rows[0];
  if (!memberRow) return { ok: false, error: "not_participant" };

  const keysExist = Number(memberRow.keys_exist) === 1;
  const enveloped = isEnvelope(body);
  if (keysExist && !enveloped) return { ok: false, error: "encryption_required" };
  const limit = enveloped ? MAX_CIPHERTEXT_LENGTH : MAX_MESSAGE_LENGTH;
  if (body.length > limit) return { ok: false, error: "too_long" };

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
