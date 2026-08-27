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
 *
 * Moderated asks (rows in hidden_asks) do not exist to matching, on either
 * side of the table: they neither appear as matches nor anchor them.
 */

import { getDb, now } from "./db.ts";
import { newId } from "./crypto.ts";
import { unpackTags, type AskStatus } from "./taxonomy.ts";
import { isExclusivity, type Exclusivity } from "./terms.ts";
import { recordedVolumeByUser } from "./stats.ts";
import { usdRounded10k } from "../components/deals/format.ts";

/* ------------------------------------------------ recorded-volume priority
 *
 * The bribe that makes being on the record worth its fee: an account's
 * confirmed, co-attested recorded volume raises the visibility of its asks on
 * the board and its position in others' match lists. This is a SECONDARY sort
 * applied AFTER recency, never a replacement for it. Recency is bucketed to a
 * window and stays the dominant key; within one window, recorded volume lifts
 * an ask; exact createdAt is the final, stable tiebreak. A brand-new or
 * record-empty account still appears, just lower inside its own window, never
 * buried under older ones.
 *
 * The volume that moves a bucket is exactly the volume that accrues the
 * referral fee (lib/stats.ts recordedVolumeByUser shares the fee predicate),
 * so buying priority means paying. Exact figures never leave the server: only
 * the coarse bucket (a chip, or a sort position) is ever exposed.
 */

/**
 * Dollar thresholds separating recorded-volume buckets, aligned to the public
 * $10k rounding. Coarse on purpose: crossing one takes real recorded volume.
 */
export const RECORDED_VOLUME_BUCKETS = [
  10_000, 50_000, 250_000, 1_000_000,
] as const;

/** How long one recency window is. Recency dominates at this granularity. */
export const PRIORITY_RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Bucket 0..N for a recorded attested volume. 0 means record-empty (<$10k). */
export function recordedVolumeBucket(volumeUsd: number): number {
  let b = 0;
  for (const threshold of RECORDED_VOLUME_BUCKETS) {
    if (volumeUsd >= threshold) b += 1;
  }
  return b;
}

/**
 * The bucketed track-record chip a poster wears, or null below the first
 * threshold: a record-empty poster wears nothing. Never the exact figure;
 * always the floor of the account's bucket with a "+", e.g. "$250k+".
 */
export function recordedVolumeChip(volumeUsd: number): string | null {
  const b = recordedVolumeBucket(volumeUsd);
  if (b === 0) return null;
  return `${usdRounded10k(RECORDED_VOLUME_BUCKETS[b - 1])}+`;
}

/** Age in whole recency windows: 0 = current window (newest), larger = older. */
export function recencyBucket(createdAt: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - createdAt) / PRIORITY_RECENCY_WINDOW_MS));
}

/**
 * Effective track-record bucket: the volume bucket, lifted one rung when the
 * account has committed evidence on a co-attested deal (the strictly
 * harder-to-fake tier, the "tier mix" factor). A record-empty account is never
 * lifted, so evidence can only sharpen a ranking that recorded volume already
 * earned.
 */
export function trackRecordBucket(
  volumeUsd: number,
  evidenceBackedDeals: number,
): number {
  const base = recordedVolumeBucket(volumeUsd);
  const lifted = base > 0 && evidenceBackedDeals > 0 ? base + 1 : base;
  return Math.min(lifted, RECORDED_VOLUME_BUCKETS.length + 1);
}

/* ------------------------------------------------ recorder standing tiers (C)
 *
 * BUILDER 2 mechanism C. The recorder-standing tier is exactly the
 * track-record bucket above, given a name and three benefits that read off it:
 *
 *   - MATCHING PRIORITY: comparePriority sorts by this tier (below), so more
 *     recorded, evidenced volume lifts an account's asks and match position.
 *   - INVITE CAP: lib/invites.ts maxUnusedInvites(tier) grows the unused-code
 *     cap one slot per tier above the base.
 *   - TRUSTED-RECORDER BADGE: tier >= TRUSTED_RECORDER_MIN_TIER earns a visible
 *     badge on the account's asks (components/ask/meta.tsx TrustedRecorderBadge).
 *
 * The volume that unlocks all three is the same confirmed, co-attested volume
 * the referral fee accrues on (lib/stats.ts recordedVolumeByUser shares the fee
 * predicate), so a standing benefit is never free: the volume that unlocks it
 * is the volume that paid. Exact figures never leave the server; only the tier,
 * the bucketed chip, and the badge do.
 */

/** A tier at or above this earns the visible "trusted recorder" badge. */
export const TRUSTED_RECORDER_MIN_TIER = 3;

export type RecorderStanding = {
  /** 0..RECORDED_VOLUME_BUCKETS.length+1: the key comparePriority and the cap read. */
  tier: number;
  /** The bucketed track-record chip ("$250k+"), or null when unrecorded. */
  chip: string | null;
  /** A short label for the compact status: unrecorded / recorder / trusted. */
  label: string;
  /** Whether the account clears the trusted-recorder threshold. */
  trusted: boolean;
};

/** One account's recorder standing from its (server-only) recorded volume. */
export function recorderStanding(
  volumeUsd: number,
  evidenceBackedDeals: number,
): RecorderStanding {
  const tier = trackRecordBucket(volumeUsd, evidenceBackedDeals);
  const trusted = tier >= TRUSTED_RECORDER_MIN_TIER;
  return {
    tier,
    chip: recordedVolumeChip(volumeUsd),
    label: tier === 0 ? "Unrecorded" : trusted ? "Trusted recorder" : "Recorder",
    trusted,
  };
}

/** What the priority comparator needs about one ask. */
export type PriorityInput = {
  createdAt: number;
  volumeUsd: number;
  evidenceBackedDeals: number;
};

/**
 * Secondary sort AFTER recency. Returns < 0 when a should sort before b.
 * Recency window is primary (newer first); within a window, higher track record
 * first; exact createdAt breaks the rest so the order is total and stable.
 */
export function comparePriority(
  a: PriorityInput,
  b: PriorityInput,
  nowMs: number,
): number {
  const ra = recencyBucket(a.createdAt, nowMs);
  const rb = recencyBucket(b.createdAt, nowMs);
  if (ra !== rb) return ra - rb;
  // Recorder-standing tier is the priority weight: a higher tier sorts first
  // within a recency window. It is the same key the invite cap and the badge
  // read, so all three standing benefits move together with recorded volume.
  const ta = recorderStanding(a.volumeUsd, a.evidenceBackedDeals).tier;
  const tb = recorderStanding(b.volumeUsd, b.evidenceBackedDeals).tier;
  if (ta !== tb) return tb - ta;
  return b.createdAt - a.createdAt;
}

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
  /** Stated terms (ask_terms); null for asks that predate them. */
  exclusivity: Exclusivity | null;
  /** Poster's bucketed recorded-volume chip ("$250k+"), or null if record-empty. */
  trackRecordChip: string | null;
};

/** The viewer's own ask, reduced to what the comparison needs. */
export type OwnAsk = {
  id: string;
  title: string;
  status: AskStatus;
  supplyFilledPct: number;
  buyerIsOther: boolean;
  createdAt: number;
  /** Stated terms (ask_terms); null for asks that predate them. */
  exclusivity: Exclusivity | null;
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
                 o.user_id AS poster_id, u.username AS poster_username,
                 t.exclusivity
            FROM asks o
            JOIN users u ON u.id = o.user_id
            LEFT JOIN ask_terms t ON t.ask_id = o.id
           WHERE o.user_id <> ?
             AND o.status <> 'closed'
             AND o.id NOT IN (SELECT ask_id FROM hidden_asks)
             AND o.buyer_token IN (SELECT buyer_token FROM asks
                                    WHERE user_id = ?
                                      AND id NOT IN (SELECT ask_id FROM hidden_asks))
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
      exclusivity: isExclusivity(r.exclusivity) ? r.exclusivity : null,
      trackRecordChip: null,
    });
  }

  const mine = await db.execute({
    sql: `SELECT a.id, a.title, a.status, a.supply_filled_pct, a.buyer_token,
                 a.buyer_is_other, a.created_at, t.exclusivity
            FROM asks a
            LEFT JOIN ask_terms t ON t.ask_id = a.id
           WHERE a.user_id = ?
             AND a.id NOT IN (SELECT ask_id FROM hidden_asks)
           ORDER BY a.created_at DESC`,
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
      exclusivity: isExclusivity(r.exclusivity) ? r.exclusivity : null,
    });
  }

  // Recorded-volume priority, applied as a secondary sort after recency. Look
  // up every matched poster's recorded attested volume once, stamp each ask
  // with its bucketed chip (exact figures never leave here), then order asks
  // within each group and the groups themselves by the same priority key.
  const posterIds = [
    ...new Set(
      [...groups.values()].flatMap((g) => g.otherAsks.map((a) => a.posterId)),
    ),
  ];
  const volumes = await recordedVolumeByUser(posterIds);
  const nowMs = now();
  const priorityOf = (a: MatchedAsk): PriorityInput => {
    const v = volumes.get(a.posterId);
    return {
      createdAt: a.createdAt,
      volumeUsd: v?.volumeUsd ?? 0,
      evidenceBackedDeals: v?.evidenceBackedDeals ?? 0,
    };
  };
  for (const g of groups.values()) {
    for (const a of g.otherAsks) {
      a.trackRecordChip = recordedVolumeChip(volumes.get(a.posterId)?.volumeUsd ?? 0);
    }
    g.otherAsks.sort((a, b) => comparePriority(priorityOf(a), priorityOf(b), nowMs));
  }

  // Group order follows each group's top-priority ask, so a group led by a
  // high-track-record ask surfaces above one led by an older or record-empty one.
  return [...groups.values()].sort((a, b) => {
    const ta = a.otherAsks[0];
    const tb = b.otherAsks[0];
    if (!ta || !tb) return (tb ? 1 : 0) - (ta ? 1 : 0);
    return comparePriority(priorityOf(ta), priorityOf(tb), nowMs);
  });
}

/** How many live asks by others currently share a buyer token with the viewer. */
export async function countMatchedAsks(userId: string): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n
            FROM asks o
           WHERE o.user_id <> ?
             AND o.status <> 'closed'
             AND o.id NOT IN (SELECT ask_id FROM hidden_asks)
             AND o.buyer_token IN (SELECT buyer_token FROM asks
                                    WHERE user_id = ?
                                      AND id NOT IN (SELECT ask_id FROM hidden_asks))`,
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

/* ------------------------------------------------------ supplier pooling */

/** Another supplier with a live offer on the same ask as the viewer. */
export type CoOfferer = {
  username: string;
  status: "pending" | "accepted";
};

/** An ask the viewer has a live offer on, with the other suppliers on it. */
export type CoOfferedAsk = {
  askId: string;
  askTitle: string;
  askStatus: AskStatus;
  supplyFilledPct: number;
  posterUsername: string;
  myStatus: "pending" | "accepted";
  others: CoOfferer[];
};

/**
 * Every ask the viewer has a live (pending or accepted) collab request on,
 * with the OTHER live requesters on the same ask. This is how a supplier
 * with no asks of their own finds partners: two people offering into the
 * same ask are either pooling or undercutting, and they only get to choose
 * if they can see each other. Declined and withdrawn requests are invisible
 * on both sides: a declined supplier is not on the ask, and showing them
 * would leak the poster's decision. Hidden asks do not exist here, same as
 * everywhere in matching.
 */
export async function listCoOfferedAsks(userId: string): Promise<CoOfferedAsk[]> {
  const db = await getDb();
  const mine = await db.execute({
    sql: `SELECT a.id, a.title, a.status, a.supply_filled_pct,
                 pu.username AS poster_username,
                 cr.status AS my_status, cr.created_at AS requested_at
            FROM collab_requests cr
            JOIN asks a  ON a.id  = cr.ask_id
            JOIN users pu ON pu.id = a.user_id
           WHERE cr.requester_id = ?
             AND cr.status IN ('pending', 'accepted')
             AND a.id NOT IN (SELECT ask_id FROM hidden_asks)
           ORDER BY cr.created_at DESC`,
    args: [userId],
  });
  if (mine.rows.length === 0) return [];

  const asks: CoOfferedAsk[] = mine.rows.map((r) => ({
    askId: String(r.id),
    askTitle: String(r.title),
    askStatus: toStatus(r.status),
    supplyFilledPct: Number(r.supply_filled_pct),
    posterUsername: String(r.poster_username),
    myStatus: String(r.my_status) === "accepted" ? "accepted" : "pending",
    others: [],
  }));

  const ids = asks.map((a) => a.askId);
  const placeholders = ids.map(() => "?").join(", ");
  const others = await db.execute({
    sql: `SELECT cr.ask_id, cr.status, u.username
            FROM collab_requests cr
            JOIN users u ON u.id = cr.requester_id
           WHERE cr.ask_id IN (${placeholders})
             AND cr.requester_id <> ?
             AND cr.status IN ('pending', 'accepted')
           ORDER BY cr.created_at ASC`,
    args: [...ids, userId],
  });
  const byAsk = new Map(asks.map((a) => [a.askId, a]));
  for (const r of others.rows) {
    byAsk.get(String(r.ask_id))?.others.push({
      username: String(r.username),
      status: String(r.status) === "accepted" ? "accepted" : "pending",
    });
  }
  return asks;
}

/**
 * How many asks the viewer has on the board that matching can anchor to.
 * Exists so /matches can be honest about WHY a section is empty: no asks is
 * a different situation from asks with no overlap.
 */
export async function countOwnAsks(userId: string): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM asks
           WHERE user_id = ? AND id NOT IN (SELECT ask_id FROM hidden_asks)`,
    args: [userId],
  });
  return Number(rs.rows[0]?.n ?? 0);
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
  // Closed asks still take requests: the ask is finished, the poster is not.

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
