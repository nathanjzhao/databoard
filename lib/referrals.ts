/**
 * lib/referrals.ts
 *
 * The referral ledger. Server-only, async, raw SQL over invite_edges,
 * deal_participants, referral_settlements and referral_disputes.
 *
 * THE RULE, exactly as /terms states it: joining through an invite is
 * agreeing that every ANCESTOR in your invite chain accrues a fee from your
 * board-recorded earnings, decaying geometrically by step: your inviter
 * 2.5%, their inviter 2.5% of 2.5% (0.0625%), the next 2.5%^3, and so on.
 *
 * Earnings := your own CONFIRMED shares on deals at co-attested tier or
 * better (at least one named participant confirmed, none pending). Solo
 * claimed deals accrue nothing: a unilateral claim is not an earning anyone
 * else vouched for. Declined and pending shares are worth nothing, exactly
 * as on the leaderboard.
 *
 * DEPTH CAP: the walk stops at 6 steps. 2.5%^6 of a share is about 2 parts
 * in 10 billion; on a $1M share that is a fiftieth of a cent. Beyond the cap
 * the amounts are dust that would cost more to display than they are worth,
 * so the cap is documented here and in the UI rather than pretended away.
 *
 * ARITHMETIC: exact integer cents internally. 2.5% is exactly 1/40, so the
 * rate at depth d is 1/40^d and each accrual is Math.round(share_cents /
 * 40^d), rounded once per (share, ancestor) pair. Only DISPLAY rounds to
 * whole dollars.
 *
 * NOTHING HERE MOVES MONEY. referral_accruals is a computed view, derived
 * on every read; referral_settlements records what two members say they
 * settled off-platform (payee records receipt, against their own interest;
 * payer confirms); referral_disputes is the escape valve. Enforcement is
 * privilege-gating only: an account behind on obligations cannot post asks
 * or record deals until it settles or disputes (settlementStanding below).
 * At-source deduction is the Stripe Connect path in docs/PAYMENTS.md,
 * planned, not shipped.
 */

import { getDb, now } from "./db.ts";
import { newId } from "./crypto.ts";

/* -------------------------------------------------------------- constants */

/** 2.5% per step, exactly 1/40. */
export const REFERRAL_RATE_DENOM = 40;
/** Steps up the chain that accrue. Beyond 6 the amounts are dust; see above. */
export const MAX_REFERRAL_DEPTH = 6;
/** Outstanding accruals older than this mark the payer "behind". */
export const SETTLEMENT_GRACE_MS = 60 * 24 * 60 * 60 * 1000;
/** Pairs owing less than a dollar never gate anything. Dust does not block. */
export const MIN_BLOCKING_OUTSTANDING_CENTS = 100;

export const MAX_SETTLEMENT_NOTE_LENGTH = 200;
export const MAX_SETTLEMENT_CENTS = 100_000_000_00; // $100M; above that, a bank.

/** Cents accrued to an ancestor at `depth` from a whole-dollar share. */
export function accrualCents(shareUsd: number, depth: number): number {
  return Math.round((shareUsd * 100) / Math.pow(REFERRAL_RATE_DENOM, depth));
}

/* ------------------------------------------------------------- the chain */

export type ChainNode = { userId: string; username: string; depth: number };

/**
 * The ancestors of an account, nearest first, capped at MAX_REFERRAL_DEPTH.
 * A seen-set guards against a hand-crafted cycle ever looping the walk.
 */
export async function ancestorChain(userId: string): Promise<ChainNode[]> {
  const db = await getDb();
  const chain: ChainNode[] = [];
  const seen = new Set<string>([userId]);
  let current = userId;
  for (let depth = 1; depth <= MAX_REFERRAL_DEPTH; depth++) {
    const rs = await db.execute({
      sql: `SELECT e.inviter_id, u.username
              FROM invite_edges e JOIN users u ON u.id = e.inviter_id
             WHERE e.user_id = ?`,
      args: [current],
    });
    const row = rs.rows[0];
    if (!row) break;
    const inviterId = String(row.inviter_id);
    if (seen.has(inviterId)) break;
    seen.add(inviterId);
    chain.push({ userId: inviterId, username: String(row.username), depth });
    current = inviterId;
  }
  return chain;
}

/**
 * Every descendant within MAX_REFERRAL_DEPTH, breadth-first, so each carries
 * the depth at which the viewer sits on THEIR chain (= the viewer's rate on
 * their earnings).
 */
export async function descendantTree(userId: string): Promise<ChainNode[]> {
  const db = await getDb();
  const out: ChainNode[] = [];
  const seen = new Set<string>([userId]);
  let frontier = [userId];
  for (let depth = 1; depth <= MAX_REFERRAL_DEPTH && frontier.length > 0; depth++) {
    const placeholders = frontier.map(() => "?").join(", ");
    const rs = await db.execute({
      sql: `SELECT e.user_id, u.username
              FROM invite_edges e JOIN users u ON u.id = e.user_id
             WHERE e.inviter_id IN (${placeholders})
             ORDER BY u.username`,
      args: frontier,
    });
    const next: string[] = [];
    for (const r of rs.rows) {
      const id = String(r.user_id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ userId: id, username: String(r.username), depth });
      next.push(id);
    }
    frontier = next;
  }
  return out;
}

/* ------------------------------------------------------ qualifying earnings */

/** One qualifying earning: a confirmed share on a co-attested-or-better deal. */
export type EarningEvent = {
  dealId: string;
  shareUsd: number;
  /** When the deal tipped to co-attested: its last confirmation timestamp. */
  accruedAt: number;
};

/**
 * Qualifying earnings for a set of accounts, one query. The predicate is the
 * same co-attested-or-better test lib/deals.ts derives in process: at least
 * one named participant confirmed, none pending. Zero-dollar shares are kept
 * out; they accrue nothing and would only pad the walk.
 */
export async function earningEventsFor(
  userIds: string[],
): Promise<Map<string, EarningEvent[]>> {
  const out = new Map<string, EarningEvent[]>();
  if (userIds.length === 0) return out;
  const db = await getDb();
  const placeholders = userIds.map(() => "?").join(", ");
  const rs = await db.execute({
    sql: `SELECT p.user_id, p.share_usd, p.deal_id,
                 (SELECT MAX(q.confirmed_at) FROM deal_participants q
                   WHERE q.deal_id = p.deal_id AND q.status = 'confirmed') AS attested_at
            FROM deal_participants p
           WHERE p.user_id IN (${placeholders})
             AND p.status = 'confirmed'
             AND p.share_usd > 0
             AND EXISTS (SELECT 1 FROM deal_participants q
                          WHERE q.deal_id = p.deal_id AND q.role = 'participant'
                            AND q.status = 'confirmed')
             AND NOT EXISTS (SELECT 1 FROM deal_participants q
                              WHERE q.deal_id = p.deal_id AND q.role = 'participant'
                                AND q.status = 'pending')`,
    args: userIds,
  });
  for (const r of rs.rows) {
    const uid = String(r.user_id);
    const list = out.get(uid) ?? [];
    list.push({
      dealId: String(r.deal_id),
      shareUsd: Number(r.share_usd),
      accruedAt: Number(r.attested_at ?? 0),
    });
    out.set(uid, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.accruedAt - b.accruedAt);
  return out;
}

/* ------------------------------------------------------------- the ledger */

export type SettlementRow = {
  id: string;
  amountCents: number;
  note: string;
  settledAt: number;
  confirmedByPayer: boolean;
};

/** A descendant who accrues to the viewer. */
export type DownlineRow = {
  username: string;
  depth: number;
  /** Their lifetime qualifying earnings, cents. */
  lifetimeEarningsCents: number;
  /** What accrued to the viewer from those earnings, cents. */
  accruedCents: number;
  settledCents: number;
  outstandingCents: number;
  disputed: boolean;
  settlements: SettlementRow[];
};

/** An ancestor the viewer accrues to. */
export type UplineRow = {
  username: string;
  depth: number;
  accruedCents: number;
  settledCents: number;
  outstandingCents: number;
  disputed: boolean;
  settlements: SettlementRow[];
  /** FIFO: when the oldest not-yet-covered accrual landed. Null = covered. */
  oldestUnsettledAt: number | null;
};

export type ReferralLedger = {
  downline: DownlineRow[];
  upline: UplineRow[];
  /** The viewer's own lifetime qualifying earnings, cents. */
  myLifetimeEarningsCents: number;
};

function sumSettled(rows: SettlementRow[]): number {
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

/**
 * FIFO coverage: settled cents pay down accruals oldest-first. Returns the
 * timestamp of the first accrual the settled total does not fully cover, or
 * null when everything is covered.
 */
function oldestUncovered(
  events: EarningEvent[],
  depth: number,
  settledCents: number,
): number | null {
  let cumulative = 0;
  for (const e of events) {
    cumulative += accrualCents(e.shareUsd, depth);
    if (cumulative > settledCents) return e.accruedAt;
  }
  return null;
}

function toSettlementRow(r: Record<string, unknown>): SettlementRow {
  return {
    id: String(r.id),
    amountCents: Number(r.amount_cents),
    note: String(r.note ?? ""),
    settledAt: Number(r.settled_at),
    confirmedByPayer: Number(r.confirmed_by_payer) === 1,
  };
}

/**
 * The whole two-sided ledger for one account: who accrues to them (downline)
 * and whom they accrue to (upline). Derived on every read; nothing stored.
 */
export async function computeReferralLedger(userId: string): Promise<ReferralLedger> {
  const db = await getDb();
  const [ancestors, descendants] = await Promise.all([
    ancestorChain(userId),
    descendantTree(userId),
  ]);

  const events = await earningEventsFor([
    userId,
    ...descendants.map((d) => d.userId),
  ]);

  const [settlementsRs, disputesRs] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM referral_settlements
             WHERE payer_id = ? OR payee_id = ?
             ORDER BY settled_at ASC`,
      args: [userId, userId],
    }),
    db.execute({
      sql: `SELECT payer_id, payee_id FROM referral_disputes
             WHERE payer_id = ? OR payee_id = ?`,
      args: [userId, userId],
    }),
  ]);

  const settledByPair = new Map<string, SettlementRow[]>();
  for (const r of settlementsRs.rows) {
    const key = `${String(r.payer_id)}\x1f${String(r.payee_id)}`;
    const list = settledByPair.get(key) ?? [];
    list.push(toSettlementRow(r));
    settledByPair.set(key, list);
  }
  const disputedPairs = new Set(
    disputesRs.rows.map((r) => `${String(r.payer_id)}\x1f${String(r.payee_id)}`),
  );

  const downline: DownlineRow[] = descendants.map((d) => {
    const theirEvents = events.get(d.userId) ?? [];
    const accrued = theirEvents.reduce(
      (s, e) => s + accrualCents(e.shareUsd, d.depth),
      0,
    );
    const pairKey = `${d.userId}\x1f${userId}`;
    const settlements = settledByPair.get(pairKey) ?? [];
    const settled = sumSettled(settlements);
    return {
      username: d.username,
      depth: d.depth,
      lifetimeEarningsCents: theirEvents.reduce((s, e) => s + e.shareUsd * 100, 0),
      accruedCents: accrued,
      settledCents: settled,
      outstandingCents: Math.max(0, accrued - settled),
      disputed: disputedPairs.has(pairKey),
      settlements,
    };
  });

  const myEvents = events.get(userId) ?? [];
  const upline: UplineRow[] = ancestors.map((a) => {
    const accrued = myEvents.reduce(
      (s, e) => s + accrualCents(e.shareUsd, a.depth),
      0,
    );
    const pairKey = `${userId}\x1f${a.userId}`;
    const settlements = settledByPair.get(pairKey) ?? [];
    const settled = sumSettled(settlements);
    return {
      username: a.username,
      depth: a.depth,
      accruedCents: accrued,
      settledCents: settled,
      outstandingCents: Math.max(0, accrued - settled),
      disputed: disputedPairs.has(pairKey),
      settlements,
      oldestUnsettledAt: oldestUncovered(myEvents, a.depth, settled),
    };
  });

  return {
    downline,
    upline,
    myLifetimeEarningsCents: myEvents.reduce((s, e) => s + e.shareUsd * 100, 0),
  };
}

/* --------------------------------------------------------------- standing */

export type StandingPair = {
  payeeUsername: string;
  outstandingCents: number;
  oldestUnsettledAt: number;
};

export type SettlementStanding =
  | { behind: false }
  | { behind: true; pairs: StandingPair[] };

/**
 * Whether an account is behind on its referral obligations: some ancestor
 * pair has an outstanding balance of at least a dollar whose oldest
 * uncovered accrual is more than 60 days old, and the pair is not disputed.
 * A behind account cannot post asks or record deals (the gates live in those
 * routes); settling or disputing lifts the block. Privilege-gating only:
 * nothing here touches money.
 */
export async function settlementStanding(userId: string): Promise<SettlementStanding> {
  const db = await getDb();
  const ancestors = await ancestorChain(userId);
  if (ancestors.length === 0) return { behind: false };

  const events = (await earningEventsFor([userId])).get(userId) ?? [];
  if (events.length === 0) return { behind: false };

  const [settlementsRs, disputesRs] = await Promise.all([
    db.execute({
      sql: `SELECT payee_id, SUM(amount_cents) AS settled
              FROM referral_settlements WHERE payer_id = ? GROUP BY payee_id`,
      args: [userId],
    }),
    db.execute({
      sql: `SELECT payee_id FROM referral_disputes WHERE payer_id = ?`,
      args: [userId],
    }),
  ]);
  const settledByPayee = new Map(
    settlementsRs.rows.map((r) => [String(r.payee_id), Number(r.settled ?? 0)]),
  );
  const disputedPayees = new Set(disputesRs.rows.map((r) => String(r.payee_id)));

  const cutoff = now() - SETTLEMENT_GRACE_MS;
  const pairs: StandingPair[] = [];
  for (const a of ancestors) {
    if (disputedPayees.has(a.userId)) continue;
    const settled = settledByPayee.get(a.userId) ?? 0;
    const accrued = events.reduce((s, e) => s + accrualCents(e.shareUsd, a.depth), 0);
    const outstanding = accrued - settled;
    if (outstanding < MIN_BLOCKING_OUTSTANDING_CENTS) continue;
    const oldest = oldestUncovered(events, a.depth, settled);
    if (oldest == null || oldest > cutoff) continue;
    pairs.push({
      payeeUsername: a.username,
      outstandingCents: outstanding,
      oldestUnsettledAt: oldest,
    });
  }
  return pairs.length > 0 ? { behind: true, pairs } : { behind: false };
}

/* ------------------------------------------------------------ settlements */

export type RecordSettlementResult =
  | { ok: true; id: string }
  | {
      ok: false;
      error: "unknown_username" | "not_in_chain" | "bad_amount" | "bad_note";
    };

/**
 * The PAYEE (the ancestor, the creditor) records money received off the
 * platform. Recording is against the payee's own interest (it reduces what
 * the ledger says they are owed), which is what makes a one-sided record
 * trustworthy enough to count immediately; the payer's confirmation makes
 * it mutual. The payer must actually sit in the payee's downline within the
 * depth cap.
 */
export async function recordSettlement(
  payeeId: string,
  payerUsername: string,
  amountCents: number,
  note: string,
): Promise<RecordSettlementResult> {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_SETTLEMENT_CENTS
  ) {
    return { ok: false, error: "bad_amount" };
  }
  const trimmedNote = (note ?? "").trim();
  if (trimmedNote.length > MAX_SETTLEMENT_NOTE_LENGTH) {
    return { ok: false, error: "bad_note" };
  }

  const db = await getDb();
  const userRs = await db.execute({
    sql: `SELECT id FROM users WHERE username = ?`,
    args: [(payerUsername ?? "").trim().toLowerCase()],
  });
  const payerRow = userRs.rows[0];
  if (!payerRow) return { ok: false, error: "unknown_username" };
  const payerId = String(payerRow.id);

  const payerAncestors = await ancestorChain(payerId);
  if (!payerAncestors.some((a) => a.userId === payeeId)) {
    return { ok: false, error: "not_in_chain" };
  }

  const id = newId("rst");
  await db.execute({
    sql: `INSERT INTO referral_settlements
            (id, payer_id, payee_id, amount_cents, note, settled_at, confirmed_by_payer)
          VALUES (?, ?, ?, ?, ?, ?, 0)`,
    args: [id, payerId, payeeId, amountCents, trimmedNote, now()],
  });
  return { ok: true, id };
}

export type ConfirmSettlementResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "already_confirmed" };

/** The payer co-signs a settlement the payee recorded. Own rows only. */
export async function confirmSettlement(
  settlementId: string,
  payerId: string,
): Promise<ConfirmSettlementResult> {
  const db = await getDb();
  const upd = await db.execute({
    sql: `UPDATE referral_settlements SET confirmed_by_payer = 1
           WHERE id = ? AND payer_id = ? AND confirmed_by_payer = 0`,
    args: [settlementId, payerId],
  });
  if (upd.rowsAffected > 0) return { ok: true };
  const rs = await db.execute({
    sql: `SELECT 1 FROM referral_settlements WHERE id = ? AND payer_id = ?`,
    args: [settlementId, payerId],
  });
  return rs.rows.length > 0
    ? { ok: false, error: "already_confirmed" }
    : { ok: false, error: "not_found" };
}

/* --------------------------------------------------------------- disputes */

export type RaiseDisputeResult =
  | { ok: true }
  | { ok: false; error: "unknown_username" | "not_in_chain" | "already_disputed" };

/**
 * Either account on a pair can mark it disputed. The direction is derived,
 * not declared: the counterparty must be an ancestor or a descendant of the
 * caller within the depth cap. A disputed pair stops gating the payer and is
 * listed for operators; the row stays until an operator resolves it by hand.
 */
export async function raiseDispute(
  callerId: string,
  otherUsername: string,
): Promise<RaiseDisputeResult> {
  const db = await getDb();
  const userRs = await db.execute({
    sql: `SELECT id FROM users WHERE username = ?`,
    args: [(otherUsername ?? "").trim().toLowerCase()],
  });
  const otherRow = userRs.rows[0];
  if (!otherRow) return { ok: false, error: "unknown_username" };
  const otherId = String(otherRow.id);

  const callerAncestors = await ancestorChain(callerId);
  let payerId: string;
  let payeeId: string;
  if (callerAncestors.some((a) => a.userId === otherId)) {
    payerId = callerId;
    payeeId = otherId; // caller owes up to other
  } else {
    const otherAncestors = await ancestorChain(otherId);
    if (!otherAncestors.some((a) => a.userId === callerId)) {
      return { ok: false, error: "not_in_chain" };
    }
    payerId = otherId; // other owes up to caller
    payeeId = callerId;
  }

  const ins = await db.execute({
    sql: `INSERT INTO referral_disputes (payer_id, payee_id, raised_by, raised_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (payer_id, payee_id) DO NOTHING`,
    args: [payerId, payeeId, callerId, now()],
  });
  return ins.rowsAffected > 0
    ? { ok: true }
    : { ok: false, error: "already_disputed" };
}

/** Every open dispute, for the operator block on /invites. */
export type OpenDispute = {
  payerUsername: string;
  payeeUsername: string;
  raisedByUsername: string;
  raisedAt: number;
};

export async function listOpenDisputes(): Promise<OpenDispute[]> {
  const db = await getDb();
  const rs = await db.execute(
    `SELECT pu.username AS payer_username, yu.username AS payee_username,
            ru.username AS raised_by_username, d.raised_at
       FROM referral_disputes d
       JOIN users pu ON pu.id = d.payer_id
       JOIN users yu ON yu.id = d.payee_id
       JOIN users ru ON ru.id = d.raised_by
      ORDER BY d.raised_at DESC`,
  );
  return rs.rows.map((r) => ({
    payerUsername: String(r.payer_username),
    payeeUsername: String(r.payee_username),
    raisedByUsername: String(r.raised_by_username),
    raisedAt: Number(r.raised_at),
  }));
}
