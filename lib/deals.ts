/**
 * lib/deals.ts
 *
 * The deals ledger. Server-only, async end to end, raw SQL against the two
 * tables at the bottom of db/schema.sql (deals, deal_participants).
 *
 * Shape of a deal: one reporter, zero or more named participants, each row
 * carrying an exact dollar share. Shares are uneven on purpose and their sum
 * may fall short of the total (costs, parties not on the board); it can never
 * exceed it, enforced both here and by a trigger in the schema. Every named
 * participant confirms or declines independently on their own account. A
 * declined row never counts anywhere; other confirmations stand on their own.
 *
 * Authorization lives here, not in the callers: every reader takes the
 * viewer's user id and answers null for a deal they are not on, so a route
 * handler cannot leak whether a deal id exists. Only a named participant can
 * act on their own row, and only on their own row.
 *
 * Tier ladder, exact naming (the UI must never say "verified"):
 *   claimed             solo deals, or nobody has confirmed yet
 *   co-attested         every non-declined participant confirmed, at least one
 *   evidence committed  co-attested, plus the reporter and every confirmed
 *                       participant each committed an evidence hash
 *
 * Nothing in this module handles a buyer name. It reads tokens the create
 * route already minted, exactly like lib/matching.ts.
 */

import { getDb, now } from "./db.ts";
import { newId } from "./crypto.ts";

/* ------------------------------------------------------------- constants */

export const MAX_DEAL_NOTE_LENGTH = 2000;
export const MAX_DEAL_PARTICIPANTS = 10;
/** $1B cap. Above this you do not need a leaderboard, you need a bank. */
export const MAX_DEAL_TOTAL_USD = 1_000_000_000;
export const MAX_EVIDENCE_LABEL_LENGTH = 80;

const EVIDENCE_HASH_RE = /^[0-9a-f]{64}$/;

/* ----------------------------------------------------------------- types */

export type DealRole = "reporter" | "participant";
export type ShareStatus = "pending" | "confirmed" | "declined";
export type DealTier = "claimed" | "co_attested" | "evidence_committed";

/** One row of the split table, as pages render it. */
export type SplitRow = {
  userId: string;
  username: string;
  role: DealRole;
  shareUsd: number;
  status: ShareStatus;
  confirmedAt: number | null;
  /** Full 64-char hex commitment, or null. Participants may see each other's. */
  evidenceHash: string | null;
  evidenceLabel: string;
};

/** Everything a participant is entitled to see about one deal. */
export type DealDetail = {
  id: string;
  reporterId: string;
  reporterUsername: string;
  buyerToken: string;
  buyerIsOther: boolean;
  totalUsd: number;
  note: string;
  createdAt: number;
  askId: string | null;
  askTitle: string | null;
  threadId: string | null;
  /** Reporter first, then named participants by username. */
  split: SplitRow[];
  tier: DealTier;
  /** Named (non-reporter) rows: the n in "k of n confirmed". */
  namedCount: number;
  /** Confirmed named rows: the k. */
  confirmedCount: number;
  declinedCount: number;
  pendingCount: number;
  /** The viewer's own row. */
  viewer: SplitRow;
};

/** The three groups on /deals. */
export type DealLedger = {
  needsMyConfirmation: DealDetail[];
  awaitingOthers: DealDetail[];
  history: DealDetail[];
};

/* ------------------------------------------------------------------ tier */

type TierRow = Pick<SplitRow, "role" | "status" | "evidenceHash">;

/**
 * The tier a set of participant rows implies. Solo deals stay claimed
 * forever: with nobody else attesting, a hash on the reporter's own row is
 * still a unilateral claim and is labeled as such.
 */
export function deriveTier(rows: readonly TierRow[]): DealTier {
  const named = rows.filter((r) => r.role === "participant");
  if (named.length === 0) return "claimed";
  const confirmed = named.filter((r) => r.status === "confirmed");
  if (confirmed.length === 0) return "claimed";
  if (named.some((r) => r.status === "pending")) return "claimed";
  const reporter = rows.find((r) => r.role === "reporter");
  const everyHashCommitted =
    Boolean(reporter?.evidenceHash) && confirmed.every((r) => r.evidenceHash);
  return everyHashCommitted ? "evidence_committed" : "co_attested";
}

/* -------------------------------------------------------------- creation */

export type CreateDealInput = {
  /** Already-minted buyer token. The name never reaches this module. */
  buyerToken: string;
  buyerIsOther: boolean;
  askId: string | null;
  totalUsd: number;
  /** The reporter's own cut. Zero is legal; brokers exist. */
  myShareUsd: number;
  note: string;
  participants: { username: string; shareUsd: number }[];
};

export type CreateDealResult =
  | { ok: true; dealId: string; threadId: string | null }
  | {
      ok: false;
      error:
        | "bad_total"
        | "bad_share"
        | "too_many_participants"
        | "duplicate_participant"
        | "self_participant"
        | "unknown_username"
        | "shares_exceed_total"
        | "bad_ask"
        | "note_too_long";
      detail?: string;
    };

function isWholeUsd(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Records a deal: the deal row, one participant row per person (the reporter
 * auto-confirmed), and, when anyone else is named, the deal-room thread with
 * everyone in it, all in one transaction. The subject of the thread is
 * derived from the deal (buyer label and total), which every member of the
 * thread is entitled to see because they are all on the deal.
 */
export async function createDeal(
  reporterId: string,
  reporterUsername: string,
  input: CreateDealInput,
): Promise<CreateDealResult> {
  const total = input.totalUsd;
  if (!isWholeUsd(total) || total <= 0 || total > MAX_DEAL_TOTAL_USD) {
    return {
      ok: false,
      error: "bad_total",
      detail: "Total must be a whole dollar amount above zero.",
    };
  }
  if (!isWholeUsd(input.myShareUsd)) {
    return {
      ok: false,
      error: "bad_share",
      detail: "Your share must be a whole dollar amount, zero or more.",
    };
  }
  const note = (input.note ?? "").trim();
  if (note.length > MAX_DEAL_NOTE_LENGTH) {
    return { ok: false, error: "note_too_long" };
  }
  if (input.participants.length > MAX_DEAL_PARTICIPANTS) {
    return { ok: false, error: "too_many_participants" };
  }

  const usernames = input.participants.map((p) =>
    (p.username ?? "").trim().toLowerCase(),
  );
  if (usernames.some((u) => u.length === 0)) {
    return { ok: false, error: "unknown_username", detail: "Empty username." };
  }
  if (new Set(usernames).size !== usernames.length) {
    return { ok: false, error: "duplicate_participant" };
  }
  if (usernames.includes(reporterUsername.toLowerCase())) {
    return { ok: false, error: "self_participant" };
  }
  for (const p of input.participants) {
    if (!isWholeUsd(p.shareUsd)) {
      return {
        ok: false,
        error: "bad_share",
        detail: `Share for @${p.username} must be a whole dollar amount, zero or more.`,
      };
    }
  }

  const allocated =
    input.myShareUsd + input.participants.reduce((s, p) => s + p.shareUsd, 0);
  if (allocated > total) {
    return {
      ok: false,
      error: "shares_exceed_total",
      detail: `Shares sum to more than the total by $${(allocated - total).toLocaleString("en-US")}.`,
    };
  }

  const db = await getDb();

  // Resolve usernames to ids before opening the transaction.
  const resolved: { id: string; username: string; shareUsd: number }[] = [];
  for (const p of input.participants) {
    const u = (p.username ?? "").trim().toLowerCase();
    const rs = await db.execute({
      sql: `SELECT id, username FROM users WHERE username = ?`,
      args: [u],
    });
    const row = rs.rows[0];
    if (!row) {
      return {
        ok: false,
        error: "unknown_username",
        detail: `No account named @${u}.`,
      };
    }
    if (String(row.id) === reporterId) {
      return { ok: false, error: "self_participant" };
    }
    resolved.push({
      id: String(row.id),
      username: String(row.username),
      shareUsd: p.shareUsd,
    });
  }

  let askId: string | null = null;
  if (input.askId) {
    const rs = await db.execute({
      sql: `SELECT id FROM asks WHERE id = ?`,
      args: [input.askId],
    });
    if (!rs.rows[0]) return { ok: false, error: "bad_ask" };
    askId = String(rs.rows[0].id);
  }

  const dealId = newId("dl");
  const threadId = resolved.length > 0 ? newId("thr") : null;
  const t = now();
  const subject = `Deal room · Buyer #${input.buyerToken.slice(0, 4)} · $${total.toLocaleString("en-US")}`;

  const tx = await db.transaction("write");
  try {
    if (threadId) {
      await tx.execute({
        sql: `INSERT INTO threads (id, ask_id, subject, created_at, last_message_at)
              VALUES (?, ?, ?, ?, 0)`,
        args: [threadId, askId, subject, t],
      });
      await tx.execute({
        sql: `INSERT INTO thread_participants (thread_id, user_id, joined_at, last_read_at)
              VALUES (?, ?, ?, ?)`,
        args: [threadId, reporterId, t, t],
      });
      for (const p of resolved) {
        await tx.execute({
          sql: `INSERT INTO thread_participants (thread_id, user_id, joined_at, last_read_at)
                VALUES (?, ?, ?, ?)`,
          args: [threadId, p.id, t, t],
        });
      }
    }
    await tx.execute({
      sql: `INSERT INTO deals
              (id, reporter_id, ask_id, thread_id, buyer_token, buyer_is_other,
               total_usd, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        dealId,
        reporterId,
        askId,
        threadId,
        input.buyerToken,
        input.buyerIsOther ? 1 : 0,
        total,
        note,
        t,
      ],
    });
    // The reporter's own row: auto-confirmed, because reporting is attesting.
    await tx.execute({
      sql: `INSERT INTO deal_participants
              (deal_id, user_id, role, share_usd, status, confirmed_at)
            VALUES (?, ?, 'reporter', ?, 'confirmed', ?)`,
      args: [dealId, reporterId, input.myShareUsd, t],
    });
    for (const p of resolved) {
      await tx.execute({
        sql: `INSERT INTO deal_participants
                (deal_id, user_id, role, share_usd, status)
              VALUES (?, ?, 'participant', ?, 'pending')`,
        args: [dealId, p.id, p.shareUsd],
      });
    }
    await tx.commit();
  } finally {
    tx.close();
  }

  return { ok: true, dealId, threadId };
}

/* --------------------------------------------------------------- reading */

type DealRowSql = Record<string, unknown>;

function buildDetail(
  deal: DealRowSql,
  split: SplitRow[],
  viewerId: string,
): DealDetail | null {
  const viewer = split.find((r) => r.userId === viewerId);
  if (!viewer) return null;
  const named = split.filter((r) => r.role === "participant");
  const reporter = split.find((r) => r.role === "reporter");
  return {
    id: String(deal.id),
    reporterId: String(deal.reporter_id),
    reporterUsername: reporter?.username ?? "",
    buyerToken: String(deal.buyer_token),
    buyerIsOther: Number(deal.buyer_is_other) === 1,
    totalUsd: Number(deal.total_usd),
    note: String(deal.note ?? ""),
    createdAt: Number(deal.created_at),
    askId: deal.ask_id == null ? null : String(deal.ask_id),
    askTitle: deal.ask_title == null ? null : String(deal.ask_title),
    threadId: deal.thread_id == null ? null : String(deal.thread_id),
    split,
    tier: deriveTier(split),
    namedCount: named.length,
    confirmedCount: named.filter((r) => r.status === "confirmed").length,
    declinedCount: named.filter((r) => r.status === "declined").length,
    pendingCount: named.filter((r) => r.status === "pending").length,
    viewer,
  };
}

function toSplitRow(r: Record<string, unknown>): SplitRow {
  return {
    userId: String(r.user_id),
    username: String(r.username),
    role: String(r.role) === "reporter" ? "reporter" : "participant",
    shareUsd: Number(r.share_usd),
    status:
      String(r.status) === "confirmed"
        ? "confirmed"
        : String(r.status) === "declined"
          ? "declined"
          : "pending",
    confirmedAt: r.confirmed_at == null ? null : Number(r.confirmed_at),
    evidenceHash: r.evidence_hash == null ? null : String(r.evidence_hash),
    evidenceLabel: String(r.evidence_label ?? ""),
  };
}

/** Reporter first, then named participants alphabetically. */
function orderSplit(rows: SplitRow[]): SplitRow[] {
  return [...rows].sort((a, b) => {
    if (a.role !== b.role) return a.role === "reporter" ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
}

/**
 * One deal, in full, for a viewer who is on it. Null for a deal that does
 * not exist OR that the viewer is not a participant of; deliberately the
 * same answer, exactly like loadThread.
 */
export async function getDealForUser(
  dealId: string,
  userId: string,
): Promise<DealDetail | null> {
  const db = await getDb();
  const membership = await db.execute({
    sql: `SELECT 1 FROM deal_participants WHERE deal_id = ? AND user_id = ?`,
    args: [dealId, userId],
  });
  if (membership.rows.length === 0) return null;

  const [dealRs, splitRs] = await Promise.all([
    db.execute({
      sql: `SELECT d.*, a.title AS ask_title
              FROM deals d
              LEFT JOIN asks a ON a.id = d.ask_id
             WHERE d.id = ?`,
      args: [dealId],
    }),
    db.execute({
      sql: `SELECT p.*, u.username
              FROM deal_participants p
              JOIN users u ON u.id = p.user_id
             WHERE p.deal_id = ?`,
      args: [dealId],
    }),
  ]);
  const deal = dealRs.rows[0];
  if (!deal) return null;
  const split = orderSplit(splitRs.rows.map(toSplitRow));
  return buildDetail(deal, split, userId);
}

/**
 * Every deal the user is on, sorted into the three groups /deals renders:
 *
 *   needsMyConfirmation  their own row is pending; the prominent group
 *   awaitingOthers       their row is settled but someone else's is pending
 *   history              nothing pending: co-attested, evidence committed,
 *                        declined-out, and solo deals
 *
 * Newest first within each group.
 */
export async function listDealsFor(userId: string): Promise<DealLedger> {
  const db = await getDb();
  const dealsRs = await db.execute({
    sql: `SELECT d.*, a.title AS ask_title
            FROM deal_participants me
            JOIN deals d ON d.id = me.deal_id
            LEFT JOIN asks a ON a.id = d.ask_id
           WHERE me.user_id = ?
           ORDER BY d.created_at DESC`,
    args: [userId],
  });
  if (dealsRs.rows.length === 0) {
    return { needsMyConfirmation: [], awaitingOthers: [], history: [] };
  }

  const ids = dealsRs.rows.map((r) => String(r.id));
  const placeholders = ids.map(() => "?").join(", ");
  const splitRs = await db.execute({
    sql: `SELECT p.*, u.username
            FROM deal_participants p
            JOIN users u ON u.id = p.user_id
           WHERE p.deal_id IN (${placeholders})`,
    args: ids,
  });

  const byDeal = new Map<string, SplitRow[]>();
  for (const r of splitRs.rows) {
    const dealId = String(r.deal_id);
    const list = byDeal.get(dealId) ?? [];
    list.push(toSplitRow(r));
    byDeal.set(dealId, list);
  }

  const ledger: DealLedger = {
    needsMyConfirmation: [],
    awaitingOthers: [],
    history: [],
  };
  for (const row of dealsRs.rows) {
    const split = orderSplit(byDeal.get(String(row.id)) ?? []);
    const detail = buildDetail(row, split, userId);
    if (!detail) continue;
    if (detail.viewer.status === "pending") {
      ledger.needsMyConfirmation.push(detail);
    } else if (detail.pendingCount > 0) {
      ledger.awaitingOthers.push(detail);
    } else {
      ledger.history.push(detail);
    }
  }
  return ledger;
}

/** Pending confirmations addressed to this user. Drives the nav badge. */
export async function countPendingConfirmations(userId: string): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM deal_participants
           WHERE user_id = ? AND status = 'pending'`,
    args: [userId],
  });
  return Number(rs.rows[0]?.n ?? 0);
}

/* ------------------------------------------------------ confirm / decline */

export type ActOnShareResult =
  | { ok: true; status: "confirmed" | "declined"; tier: DealTier }
  | { ok: false; error: "not_found" | "already_handled" };

/**
 * Confirm or decline the caller's own pending row. Nobody can act on
 * anybody else's row, and a deal the caller is not on answers not_found,
 * indistinguishable from a deal that does not exist. The guarded UPDATE
 * makes a double-click resolve to already_handled instead of two writes.
 */
async function actOnOwnShare(
  dealId: string,
  userId: string,
  status: "confirmed" | "declined",
): Promise<ActOnShareResult> {
  const db = await getDb();
  const upd = await db.execute({
    sql: `UPDATE deal_participants
             SET status = ?, confirmed_at = ?
           WHERE deal_id = ? AND user_id = ? AND status = 'pending'`,
    args: [status, status === "confirmed" ? now() : null, dealId, userId],
  });
  if (upd.rowsAffected === 0) {
    const rs = await db.execute({
      sql: `SELECT 1 FROM deal_participants WHERE deal_id = ? AND user_id = ?`,
      args: [dealId, userId],
    });
    return rs.rows.length > 0
      ? { ok: false, error: "already_handled" }
      : { ok: false, error: "not_found" };
  }
  const detail = await getDealForUser(dealId, userId);
  return { ok: true, status, tier: detail?.tier ?? "claimed" };
}

export function confirmDealShare(dealId: string, userId: string) {
  return actOnOwnShare(dealId, userId, "confirmed");
}

export function declineDealShare(dealId: string, userId: string) {
  return actOnOwnShare(dealId, userId, "declined");
}

/* ------------------------------------------------------------- evidence */

export type CommitEvidenceResult =
  | { ok: true; tier: DealTier }
  | {
      ok: false;
      error: "not_found" | "not_confirmed" | "bad_hash" | "bad_label" | "already_committed";
    };

/**
 * Stores an evidence commitment on the caller's own row: a SHA-256 the
 * browser computed over a document the server never saw, plus a short label.
 * Only a confirmed row (the reporter's included; theirs is confirmed at
 * creation) can carry one, and a committed hash is immutable: a commitment
 * you can quietly swap is not a commitment. The UI says to check the file
 * before committing.
 */
export async function commitEvidence(
  dealId: string,
  userId: string,
  hashHex: string,
  label: string,
): Promise<CommitEvidenceResult> {
  const hash = (hashHex ?? "").trim().toLowerCase();
  if (!EVIDENCE_HASH_RE.test(hash)) return { ok: false, error: "bad_hash" };
  const trimmedLabel = (label ?? "").trim();
  if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_EVIDENCE_LABEL_LENGTH) {
    return { ok: false, error: "bad_label" };
  }

  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT status, evidence_hash FROM deal_participants
           WHERE deal_id = ? AND user_id = ?`,
    args: [dealId, userId],
  });
  const row = rs.rows[0];
  if (!row) return { ok: false, error: "not_found" };
  if (String(row.status) !== "confirmed") return { ok: false, error: "not_confirmed" };
  if (row.evidence_hash != null) return { ok: false, error: "already_committed" };

  const upd = await db.execute({
    sql: `UPDATE deal_participants
             SET evidence_hash = ?, evidence_label = ?
           WHERE deal_id = ? AND user_id = ?
             AND status = 'confirmed' AND evidence_hash IS NULL`,
    args: [hash, trimmedLabel, dealId, userId],
  });
  if (upd.rowsAffected === 0) return { ok: false, error: "already_committed" };

  const detail = await getDealForUser(dealId, userId);
  return { ok: true, tier: detail?.tier ?? "claimed" };
}

/* ------------------------------------------------------------- lookups */

/**
 * Username prefix search for the participant picker. Members only see what
 * the board already shows them: usernames. LIKE wildcards in the query are
 * escaped so "_" in a username means the character, not "any".
 */
export async function searchUsernames(
  q: string,
  excludeUserId: string,
  limit = 8,
): Promise<string[]> {
  const prefix = (q ?? "").trim().toLowerCase();
  if (prefix.length === 0) return [];
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT username FROM users
           WHERE username LIKE ? ESCAPE '\\' AND id <> ?
           ORDER BY username LIMIT ?`,
    args: [`${escaped}%`, excludeUserId, Math.min(Math.max(limit, 1), 20)],
  });
  return rs.rows.map((r) => String(r.username));
}

/** An ask as the record-a-deal form's "linked ask" dropdown shows it. */
export type LinkableAsk = {
  id: string;
  title: string;
  posterUsername: string;
  buyerToken: string;
};

/**
 * Recent asks a deal can be linked to. Any ask qualifies, whoever posted it:
 * deals usually fill somebody else's ask.
 */
export async function listLinkableAsks(limit = 100): Promise<LinkableAsk[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT a.id, a.title, a.buyer_token, u.username
            FROM asks a JOIN users u ON u.id = a.user_id
           ORDER BY a.created_at DESC LIMIT ?`,
    args: [Math.min(Math.max(limit, 1), 200)],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    posterUsername: String(r.username),
    buyerToken: String(r.buyer_token),
  }));
}

/**
 * The other members of a thread the viewer is in, for prefilling the
 * record-a-deal form from a deal-room-to-be. Empty when the viewer is not a
 * member, which doubles as the authorization check.
 */
export async function threadCoParticipants(
  threadId: string,
  userId: string,
): Promise<string[]> {
  const db = await getDb();
  const member = await db.execute({
    sql: `SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?`,
    args: [threadId, userId],
  });
  if (member.rows.length === 0) return [];
  const rs = await db.execute({
    sql: `SELECT u.username
            FROM thread_participants p JOIN users u ON u.id = p.user_id
           WHERE p.thread_id = ? AND p.user_id <> ?
           ORDER BY u.username`,
    args: [threadId, userId],
  });
  return rs.rows.map((r) => String(r.username));
}
