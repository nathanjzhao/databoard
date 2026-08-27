/**
 * lib/invites.ts
 *
 * Invite codes and the genealogy they leave behind. Server-only, async, raw
 * SQL over invites and invite_edges (db/schema.sql).
 *
 * The rules, all of them:
 *   * Codes are minted server-side: "inv_" + 24 hex, never user-chosen.
 *   * A member may hold at most 5 UNUSED codes at a time. Operators are
 *     uncapped; they are the supply of last resort.
 *   * Consumption is one guarded UPDATE (used_by IS NULL): a code raced by
 *     two signups is spent exactly once, and the loser is told cleanly.
 *   * Consuming writes the invite_edges row in the same transaction. The
 *     edge is the permanent genealogy; the invites row is bookkeeping.
 *   * Who invited whom is visible ONLY to the two accounts on the edge and
 *     to operators. Nothing here feeds a public surface.
 */

import { randomBytes } from "node:crypto";
import { getDb, now } from "./db.ts";
import { appendLeaf } from "./translog.ts";
import { isOperator } from "./moderation.ts";
import { recordedVolumeByUser } from "./stats.ts";
import { recorderStanding } from "./matching.ts";

export const INVITE_CODE_RE = /^inv_[0-9a-f]{24}$/;
/** The base unused-code cap. Recorder standing raises it (maxUnusedInvites). */
export const MAX_UNUSED_INVITES = 5;
/** The most extra unused slots recorder standing can add on top of the base (C). */
export const MAX_STANDING_INVITE_BONUS = 5;

/**
 * The unused-code cap for a member at a given recorder-standing tier (feature
 * C). Base MAX_UNUSED_INVITES, plus one slot per tier, capped at base +
 * MAX_STANDING_INVITE_BONUS. A record-empty account (tier 0) gets exactly the
 * base, so nothing about the cap changes for accounts with no recorded volume:
 * the larger cap is a standing benefit the same volume that pays fees unlocks.
 */
export function maxUnusedInvites(standingTier: number): number {
  const bonus = Math.max(0, Math.min(standingTier, MAX_STANDING_INVITE_BONUS));
  return MAX_UNUSED_INVITES + bonus;
}

/**
 * A member's current unused-code cap, resolved from their recorder standing.
 * The one place mintInvite and /invites both read, so the enforced cap and the
 * displayed cap can never drift. Reads the same confirmed, co-attested recorded
 * volume the fee accrues on (lib/stats.ts), so a bigger cap always cost fees.
 */
export async function unusedInviteCap(userId: string): Promise<number> {
  const vol = (await recordedVolumeByUser([userId])).get(userId);
  const standing = recorderStanding(vol?.volumeUsd ?? 0, vol?.evidenceBackedDeals ?? 0);
  return maxUnusedInvites(standing.tier);
}

/** Server-side mint format: "inv_" + 24 hex characters. */
export function generateInviteCode(): string {
  return `inv_${randomBytes(12).toString("hex")}`;
}

export function normalizeInviteCode(raw: string): string {
  return (raw ?? "").trim().toLowerCase();
}

/* ---------------------------------------------------------------- minting */

export type MintInviteResult =
  | { ok: true; code: string }
  | { ok: false; error: "limit"; cap: number };

/**
 * Mint one code for a member. Refuses when the member already holds their cap
 * of unused codes; the cap is the base plus a recorder-standing bonus
 * (maxUnusedInvites, feature C), and operators are uncapped. On refusal the
 * result carries the cap so the caller can name the right number.
 */
export async function mintInvite(userId: string): Promise<MintInviteResult> {
  const db = await getDb();
  if (!(await isOperator(userId))) {
    const cap = await unusedInviteCap(userId);
    const rs = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ? AND used_by IS NULL`,
      args: [userId],
    });
    if (Number(rs.rows[0]?.n ?? 0) >= cap) {
      return { ok: false, error: "limit", cap };
    }
  }
  const code = generateInviteCode();
  await db.execute({
    sql: `INSERT INTO invites (code, inviter_id, created_at) VALUES (?, ?, ?)`,
    args: [code, userId, now()],
  });
  return { ok: true, code };
}

/* ------------------------------------------------------------- validation */

export type InviteCheck = "ok" | "unknown" | "used";

/**
 * Whether a code exists and is still spendable. Read-only; the atomic spend
 * happens in consumeInvite. A malformed code is "unknown": the error copy
 * never distinguishes formats, so the code space cannot be probed by shape.
 */
export async function checkInviteCode(raw: string): Promise<InviteCheck> {
  const code = normalizeInviteCode(raw);
  if (!INVITE_CODE_RE.test(code)) return "unknown";
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT used_by FROM invites WHERE code = ?`,
    args: [code],
  });
  const row = rs.rows[0];
  if (!row) return "unknown";
  return row.used_by == null ? "ok" : "used";
}

/* ------------------------------------------------------------ consumption */

export type ConsumeInviteResult =
  | { ok: true; inviterId: string }
  | { ok: false; error: "unknown" | "used" };

/**
 * Spend a code for a just-created account and write the genealogy edge, one
 * transaction. The guarded UPDATE is the whole concurrency story: whichever
 * request updates the row first wins; the second sees zero rows affected and
 * loses cleanly. Callers that already created the user roll that back on a
 * loss (the user row is seconds old and referenced by nothing).
 */
export async function consumeInvite(
  raw: string,
  newUserId: string,
): Promise<ConsumeInviteResult> {
  const code = normalizeInviteCode(raw);
  if (!INVITE_CODE_RE.test(code)) return { ok: false, error: "unknown" };
  const db = await getDb();
  const tx = await db.transaction("write");
  try {
    const upd = await tx.execute({
      sql: `UPDATE invites SET used_by = ?, used_at = ?
             WHERE code = ? AND used_by IS NULL
             RETURNING inviter_id`,
      args: [newUserId, now(), code],
    });
    const row = upd.rows[0];
    if (!row) {
      await tx.rollback();
      const exists = await db.execute({
        sql: `SELECT 1 FROM invites WHERE code = ?`,
        args: [code],
      });
      return { ok: false, error: exists.rows.length > 0 ? "used" : "unknown" };
    }
    const inviterId = String(row.inviter_id);
    await tx.execute({
      sql: `INSERT INTO invite_edges (user_id, inviter_id, invite_code, created_at)
            VALUES (?, ?, ?, ?)`,
      args: [newUserId, inviterId, code, now()],
    });
    // Transparency log: an invite being consumed is a consequential, non-PII
    // event. Appended in the SAME transaction so it commits with the edge.
    // The leaf carries only a blinded code, never who used it.
    await appendLeaf(
      { type: "invite_consumed", subject: code },
      { executor: tx, dedupKey: `invite_consumed:${code}` },
    );
    await tx.commit();
    return { ok: true, inviterId };
  } finally {
    tx.close();
  }
}

/* ---------------------------------------------------------------- reading */

/** One minted code as /invites lists it. */
export type InviteRow = {
  code: string;
  createdAt: number;
  usedByUsername: string | null;
  usedAt: number | null;
};

/** Every code this member minted, newest first. */
export async function listInvitesFor(userId: string): Promise<InviteRow[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT i.code, i.created_at, i.used_at, u.username AS used_by_username
            FROM invites i LEFT JOIN users u ON u.id = i.used_by
           WHERE i.inviter_id = ?
           ORDER BY i.created_at DESC`,
    args: [userId],
  });
  return rs.rows.map((r) => ({
    code: String(r.code),
    createdAt: Number(r.created_at),
    usedByUsername: r.used_by_username == null ? null : String(r.used_by_username),
    usedAt: r.used_at == null ? null : Number(r.used_at),
  }));
}

/** Who vouched for this account, or null for accounts predating invites. */
export type InvitedBy = { username: string; at: number } | null;

export async function invitedBy(userId: string): Promise<InvitedBy> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT u.username, e.created_at
            FROM invite_edges e JOIN users u ON u.id = e.inviter_id
           WHERE e.user_id = ?`,
    args: [userId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return { username: String(row.username), at: Number(row.created_at) };
}

/** The accounts this member vouched for directly, oldest first. */
export type InviteeRow = { username: string; joinedAt: number };

export async function listInvitees(userId: string): Promise<InviteeRow[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT u.username, e.created_at
            FROM invite_edges e JOIN users u ON u.id = e.user_id
           WHERE e.inviter_id = ?
           ORDER BY e.created_at ASC`,
    args: [userId],
  });
  return rs.rows.map((r) => ({
    username: String(r.username),
    joinedAt: Number(r.created_at),
  }));
}
