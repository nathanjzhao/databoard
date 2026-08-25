/**
 * POST /api/threads/direct  { askId, username }
 *
 * Opens (or finds) a two-person thread with somebody an ask vouches for.
 * Closed asks keep their people reachable: the ask is done, the
 * relationships are not. Anyone signed in may knock, but only on people the
 * ask itself connects them to:
 *
 *   * the poster, or a confirmed participant of a deal linked to the ask
 *     (reachable by anyone signed in), or
 *   * a fellow supplier: when BOTH the caller and the recipient hold a live
 *     (pending or accepted) collab request on the ask, they are mutually
 *     reachable, so suppliers can propose pooling instead of undercutting.
 *     Declined and withdrawn requests vouch for nobody.
 *
 * Nothing here accepts a free-form recipient.
 *
 * Reply: { threadId }. The thread's encryption key is set up by the first
 * participant to open it, same as every other thread (see /api/threads/[id]/keys).
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { newId } from "@/lib/crypto";
import { getDb, now } from "@/lib/db";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { askId?: string; username?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  const askId = String(body.askId ?? "");
  const handle = String(body.username ?? "").trim().toLowerCase();
  if (!askId || !handle) {
    return NextResponse.json({ error: "askId and username are required." }, { status: 400 });
  }

  const db = await getDb();
  const askRs = await db.execute({
    sql: `SELECT id, user_id, title FROM asks WHERE id = ?`,
    args: [askId],
  });
  const ask = askRs.rows[0];
  if (!ask) return NextResponse.json({ error: "That ask does not exist." }, { status: 404 });

  const targetRs = await db.execute({
    sql: `SELECT id FROM users WHERE username = ?`,
    args: [handle],
  });
  const target = targetRs.rows[0];
  if (!target) return NextResponse.json({ error: "No such handle." }, { status: 404 });
  const targetId = String(target.id);
  if (targetId === user.id) {
    return NextResponse.json({ error: "That is you." }, { status: 400 });
  }

  // The ask has to vouch for the recipient.
  const isPoster = String(ask.user_id) === targetId;
  let vouched = isPoster;
  if (!vouched) {
    const onDeal = await db.execute({
      sql: `SELECT 1
              FROM deals d JOIN deal_participants dp ON dp.deal_id = d.id
             WHERE d.ask_id = ? AND dp.user_id = ? AND dp.status = 'confirmed'
             LIMIT 1`,
      args: [askId, targetId],
    });
    vouched = onDeal.rows.length > 0;
  }
  if (!vouched) {
    // Pooling: both sides must hold a live offer on this ask. One-sided is
    // not enough; the vouch is the shared ask, not either person's say-so.
    const pooled = await db.execute({
      sql: `SELECT 1
              FROM collab_requests mine
              JOIN collab_requests theirs
                ON theirs.ask_id = mine.ask_id
               AND theirs.requester_id = ?
             WHERE mine.ask_id = ? AND mine.requester_id = ?
               AND mine.status   IN ('pending', 'accepted')
               AND theirs.status IN ('pending', 'accepted')
             LIMIT 1`,
      args: [targetId, askId, user.id],
    });
    vouched = pooled.rows.length > 0;
  }
  if (!vouched) {
    return NextResponse.json(
      {
        error:
          "Only people this ask vouches for can be reached from here: the poster, confirmed deal participants, or a fellow supplier with a live offer.",
      },
      { status: 403 },
    );
  }

  // An existing two-person thread between the pair is reused, whatever ask
  // it started from; one conversation per pair is the point.
  const existing = await db.execute({
    sql: `SELECT t.id
            FROM threads t
            JOIN thread_participants a ON a.thread_id = t.id AND a.user_id = ?
            JOIN thread_participants b ON b.thread_id = t.id AND b.user_id = ?
           WHERE (SELECT COUNT(*) FROM thread_participants c WHERE c.thread_id = t.id) = 2
           ORDER BY t.last_message_at DESC
           LIMIT 1`,
    args: [user.id, targetId],
  });
  if (existing.rows[0]) {
    return NextResponse.json({ threadId: String(existing.rows[0].id), existed: true });
  }

  const threadId = newId("thr");
  const t = now();
  const tx = await db.transaction("write");
  try {
    await tx.execute({
      sql: `INSERT INTO threads (id, ask_id, subject, created_at, last_message_at)
            VALUES (?, ?, ?, ?, 0)`,
      args: [threadId, askId, String(ask.title), t],
    });
    for (const uid of [user.id, targetId]) {
      await tx.execute({
        sql: `INSERT INTO thread_participants (thread_id, user_id, joined_at, last_read_at)
              VALUES (?, ?, ?, ?)`,
        args: [threadId, uid, t, t],
      });
    }
    await tx.commit();
  } finally {
    tx.close();
  }
  return NextResponse.json({ threadId, existed: false });
}
