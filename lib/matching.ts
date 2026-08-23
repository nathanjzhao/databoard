/**
 * lib/matching.ts
 *
 * Buyer-overlap matching and the collaboration lifecycle. Server-only.
 *
 * The premise: buyer_token is HMAC(SERVER_PEPPER, normalized buyer name), so
 * two asks carry the same token if and only if their posters typed the same
 * buyer. Equality is visible, identity is not, and equality is all matching
 * needs. Tokens minted from the "Other" free-text field participate on the
 * same terms: identical off-list names produce identical tokens and match
 * like anything else.
 *
 * "Open" here means still soliciting supply, i.e. status 'open' or 'partial'.
 * A partially filled ask is exactly the one worth pooling toward, so it would
 * be perverse to hide it. Closed asks never appear as matches. On the viewer's
 * own side, every ask anchors matching regardless of status: a closed ask
 * still proves you named that buyer, and the live ask across the table is
 * worth seeing either way.
 *
 * Nothing in this module handles a buyer name, a contact, or any other raw
 * identifier. It reads tokens the compose path already minted.
 */

import { getDb, now } from "./db.ts";
import { newId } from "./crypto.ts";
import { unpackTags, type AskStatus } from "./taxonomy.ts";

/* ------------------------------------------------------------- matching */

/** Another member's live ask that shares a buyer token with one of yours. */
export type MatchedAsk = {
  id: string;
  title: string;
  category: string;
  modalityTags: string[];
  volume: string;
  priceBand: string;
  supplyFilledPct: number;
  buyerToken: string;
  buyerIsOther: boolean;
  status: AskStatus;
  createdAt: number;
  posterId: string;
  posterUsername: string;
};

/** The viewer's own ask, reduced to what the comparison needs. */
export type OwnAsk = {
  id: string;
  title: string;
  status: AskStatus;
  supplyFilledPct: number;
  buyerIsOther: boolean;
  createdAt: number;
};

/** Everything the board knows about one shared buyer token. */
export type BuyerMatchGroup = {
  buyerToken: string;
  buyerIsOther: boolean;
  otherAsks: MatchedAsk[];
  myAsks: OwnAsk[];
};

function toStatus(v: unknown): AskStatus {
  const s = String(v);
  return s === "partial" || s === "closed" ? s : "open";
}

/**
 * All live asks by other users whose buyer token equals the token of any ask
 * the viewer has posted, grouped per token, newest activity first.
 */
export async function findBuyerMatches(userId: string): Promise<BuyerMatchGroup[]> {
  const db = await getDb();

  const others = await db.execute({
    sql: `SELECT o.id, o.title, o.category, o.modality_tags, o.volume,
                 o.price_band, o.supply_filled_pct, o.buyer_token,
                 o.buyer_is_other, o.status, o.created_at,
                 o.user_id AS poster_id, u.username AS poster_username
            FROM asks o
            JOIN users u ON u.id = o.user_id
           WHERE o.user_id <> ?
             AND o.status <> 'closed'
             AND o.buyer_token IN (SELECT buyer_token FROM asks WHERE user_id = ?)
           ORDER BY o.created_at DESC`,
    args: [userId, userId],
  });

  if (others.rows.length === 0) return [];

  const groups = new Map<string, BuyerMatchGroup>();
  for (const r of others.rows) {
    const token = String(r.buyer_token);
    let g = groups.get(token);
    if (!g) {
      g = {
        buyerToken: token,
        buyerIsOther: Number(r.buyer_is_other) === 1,
        otherAsks: [],
        myAsks: [],
      };
      groups.set(token, g);
    }
    g.otherAsks.push({
      id: String(r.id),
      title: String(r.title),
      category: String(r.category),
      modalityTags: unpackTags(String(r.modality_tags)),
      volume: String(r.volume),
      priceBand: String(r.price_band),
      supplyFilledPct: Number(r.supply_filled_pct),
      buyerToken: token,
      buyerIsOther: Number(r.buyer_is_other) === 1,
      status: toStatus(r.status),
      createdAt: Number(r.created_at),
      posterId: String(r.poster_id),
      posterUsername: String(r.poster_username),
    });
  }

  const mine = await db.execute({
    sql: `SELECT id, title, status, supply_filled_pct, buyer_token,
                 buyer_is_other, created_at
            FROM asks
           WHERE user_id = ?
           ORDER BY created_at DESC`,
    args: [userId],
  });
  for (const r of mine.rows) {
    const g = groups.get(String(r.buyer_token));
    if (!g) continue;
    g.myAsks.push({
      id: String(r.id),
      title: String(r.title),
      status: toStatus(r.status),
      supplyFilledPct: Number(r.supply_filled_pct),
      buyerIsOther: Number(r.buyer_is_other) === 1,
      createdAt: Number(r.created_at),
    });
  }

  // Newest matched ask first decides group order.
  return [...groups.values()].sort(
    (a, b) => (b.otherAsks[0]?.createdAt ?? 0) - (a.otherAsks[0]?.createdAt ?? 0),
  );
}

/** How many live asks by others currently share a buyer token with the viewer. */
export async function countMatchedAsks(userId: string): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n
            FROM asks o
           WHERE o.user_id <> ?
             AND o.status <> 'closed'
             AND o.buyer_token IN (SELECT buyer_token FROM asks WHERE user_id = ?)`,
    args: [userId, userId],
  });
  return Number(rs.rows[0]?.n ?? 0);
}

/* ------------------------------------------------------ collab requests */

export type CollabStatus = "pending" | "accepted" | "declined" | "withdrawn";

/** A pending request from someone else, targeting one of the viewer's asks. */
export type IncomingCollabRequest = {
  id: string;
  askId: string;
  askTitle: string;
  note: string;
  createdAt: number;
  requesterId: string;
  requesterUsername: string;
};

export async function listIncomingCollabRequests(
  userId: string,
): Promise<IncomingCollabRequest[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT cr.id, cr.ask_id, cr.note, cr.created_at,
                 cr.requester_id, ru.username AS requester_username,
                 a.title AS ask_title
            FROM collab_requests cr
            JOIN asks a  ON a.id  = cr.ask_id
            JOIN users ru ON ru.id = cr.requester_id
           WHERE a.user_id = ? AND cr.status = 'pending'
           ORDER BY cr.created_at DESC`,
    args: [userId],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    askId: String(r.ask_id),
    askTitle: String(r.ask_title),
    note: String(r.note),
    createdAt: Number(r.created_at),
    requesterId: String(r.requester_id),
    requesterUsername: String(r.requester_username),
  }));
}

export async function countIncomingCollabRequests(userId: string): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n
            FROM collab_requests cr
            JOIN asks a ON a.id = cr.ask_id
           WHERE a.user_id = ? AND cr.status = 'pending'`,
    args: [userId],
  });
  return Number(rs.rows[0]?.n ?? 0);
}

/** Where one of the viewer's own requests stands, keyed for button state. */
export type OutgoingCollab = { requestId: string; status: CollabStatus };

/**
 * The viewer's own requests keyed by ask id, so the matches page can render
 * "requested" (and offer withdraw) instead of offering the button twice.
 */
export async function listOutgoingCollabRequests(
  userId: string,
): Promise<Record<string, OutgoingCollab>> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT id, ask_id, status FROM collab_requests WHERE requester_id = ?`,
    args: [userId],
  });
  const out: Record<string, OutgoingCollab> = {};
  for (const r of rs.rows) {
    out[String(r.ask_id)] = {
      requestId: String(r.id),
      status: String(r.status) as CollabStatus,
    };
  }
  return out;
}

export const MAX_COLLAB_NOTE_LENGTH = 2000;

export type CreateCollabResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      error:
        | "not_found"
        | "own_ask"
        | "ask_closed"
        | "already_requested"
        | "already_accepted"
        | "previously_declined"
        | "note_too_long";
    };

/**
 * "I have some of that." One row per requester per ask, enforced by the
 * schema's UNIQUE constraint. A withdrawn request can be re-opened with a
 * fresh note; a declined one stays declined, because the poster already
 * answered and the constraint exists so they only have to answer once.
 */
export async function createCollabRequest(
  requesterId: string,
  askId: string,
  note: string,
): Promise<CreateCollabResult> {
  const trimmed = (note ?? "").trim();
  if (trimmed.length > MAX_COLLAB_NOTE_LENGTH) {
    return { ok: false, error: "note_too_long" };
  }

  const db = await getDb();
  const askRs = await db.execute({
    sql: `SELECT id, user_id, status FROM asks WHERE id = ?`,
    args: [askId],
  });
  const ask = askRs.rows[0];
  if (!ask) return { ok: false, error: "not_found" };
  if (String(ask.user_id) === requesterId) return { ok: false, error: "own_ask" };
  if (String(ask.status) === "closed") return { ok: false, error: "ask_closed" };

  const existingRs = await db.execute({
    sql: `SELECT id, status FROM collab_requests WHERE ask_id = ? AND requester_id = ?`,
    args: [askId, requesterId],
  });
  const existing = existingRs.rows[0];
  if (existing) {
    const status = String(existing.status) as CollabStatus;
    if (status === "pending") return { ok: false, error: "already_requested" };
    if (status === "accepted") return { ok: false, error: "already_accepted" };
    if (status === "declined") return { ok: false, error: "previously_declined" };
    // withdrawn: revive the row rather than fighting the UNIQUE constraint.
    await db.execute({
      sql: `UPDATE collab_requests
               SET status = 'pending', note = ?, created_at = ?
             WHERE id = ? AND status = 'withdrawn'`,
      args: [trimmed, now(), String(existing.id)],
    });
    return { ok: true, requestId: String(existing.id) };
  }

  const id = newId("clb");
  try {
    await db.execute({
      sql: `INSERT INTO collab_requests (id, ask_id, requester_id, note, status, created_at)
            VALUES (?, ?, ?, ?, 'pending', ?)`,
      args: [id, askId, requesterId, trimmed, now()],
    });
  } catch (err) {
    // Lost a race with ourselves; the UNIQUE constraint is doing its job.
    if (String(err).includes("collab_requests")) {
      return { ok: false, error: "already_requested" };
    }
    throw err;
  }
  return { ok: true, requestId: id };
}

export type RespondCollabResult =
  | { ok: true; status: "accepted"; threadId: string }
  | { ok: true; status: "declined" | "withdrawn" }
  | { ok: false; error: "not_found" | "not_yours" | "already_handled" };

/**
 * Resolve a pending request.
 *
 *   accept   (ask owner)   marks it accepted and opens a private thread with
 *                          both users as participants. If the request carried
 *                          a note, the note becomes the thread's first
 *                          message, attributed to the requester who wrote it,
 *                          so the conversation starts where the request left
 *                          off. All rows land in one batch.
 *   decline  (ask owner)   marks it declined. No thread, no notification
 *                          channel to leak through.
 *   withdraw (requester)   marks it withdrawn; a later request may revive it.
 */
export async function respondToCollabRequest(
  userId: string,
  requestId: string,
  action: "accept" | "decline" | "withdrawn" | "withdraw",
): Promise<RespondCollabResult> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT cr.id, cr.ask_id, cr.requester_id, cr.note, cr.status,
                 a.user_id AS owner_id, a.title AS ask_title
            FROM collab_requests cr
            JOIN asks a ON a.id = cr.ask_id
           WHERE cr.id = ?`,
    args: [requestId],
  });
  const row = rs.rows[0];
  if (!row) return { ok: false, error: "not_found" };

  const ownerId = String(row.owner_id);
  const requesterId = String(row.requester_id);
  const isWithdraw = action === "withdraw" || action === "withdrawn";
  if (isWithdraw ? userId !== requesterId : userId !== ownerId) {
    return { ok: false, error: "not_yours" };
  }
  if (String(row.status) !== "pending") return { ok: false, error: "already_handled" };

  if (action === "decline" || isWithdraw) {
    const status = action === "decline" ? "declined" : "withdrawn";
    const upd = await db.execute({
      sql: `UPDATE collab_requests SET status = ? WHERE id = ? AND status = 'pending'`,
      args: [status, requestId],
    });
    if (upd.rowsAffected === 0) return { ok: false, error: "already_handled" };
    return { ok: true, status };
  }

  // Accept: request -> accepted, plus thread, participants and the opening
  // message, in one transaction. The guarded UPDATE going first means a
  // double-click or a concurrent accept flips exactly one of them into
  // thread creation; the loser rolls back with nothing written.
  const threadId = newId("thr");
  const t = now();
  const note = String(row.note ?? "").trim();
  const askId = String(row.ask_id);

  const tx = await db.transaction("write");
  try {
    const upd = await tx.execute({
      sql: `UPDATE collab_requests SET status = 'accepted' WHERE id = ? AND status = 'pending'`,
      args: [requestId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, error: "already_handled" };
    }
    await tx.execute({
      sql: `INSERT INTO threads (id, ask_id, subject, created_at, last_message_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [threadId, askId, String(row.ask_title), t, note ? t : 0],
    });
    // Both sides have already seen the note (one wrote it, one read it on the
    // request card), so neither starts the thread with a phantom unread.
    await tx.execute({
      sql: `INSERT INTO thread_participants (thread_id, user_id, joined_at, last_read_at)
            VALUES (?, ?, ?, ?)`,
      args: [threadId, ownerId, t, t],
    });
    await tx.execute({
      sql: `INSERT INTO thread_participants (thread_id, user_id, joined_at, last_read_at)
            VALUES (?, ?, ?, ?)`,
      args: [threadId, requesterId, t, t],
    });
    if (note) {
      await tx.execute({
        sql: `INSERT INTO messages (id, thread_id, sender_id, body, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [newId("msg"), threadId, requesterId, note, t],
      });
    }
    await tx.commit();
  } finally {
    tx.close();
  }
  return { ok: true, status: "accepted", threadId };
}
