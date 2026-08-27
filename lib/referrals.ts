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
 * Earnings := your own CONFIRMED shares on deals where at least one named
 * participant is confirmed (co-attested tier or better). This is the EXACT
 * predicate the leaderboard credits reputation on (lib/stats.ts): a confirmed
 * share counts the moment one counterparty has signed, whether or not some
 * OTHER named party is still pending. The two predicates must match, or a
 * never-confirming sock participant would zero the fee while the reputation
 * still lands. Solo claimed deals accrue nothing: a unilateral claim is not an
 * earning anyone else vouched for, and it is worth nothing for reputation
 * either now. Declined shares are worth nothing.
 *
 * HOUSE FLOOR: no confirmed share is ever fee-free. Every earner owes at least
 * the depth-1 increment (2.5%). When the earner has a human inviter that
 * inviter collects it. When the earner's ancestor chain is EMPTY (a
 * grandfathered, pre-invite account), the 2.5% floor accrues to the operator
 * (the invite-graph root) as house rake instead. A short chain is not topped
 * up: if the human chain is shorter than 6 the deeper geometric tail is simply
 * not charged; only the depth-1 floor is guaranteed.
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
import { appendLeafBestEffort } from "./translog.ts";
import { isOperator } from "./moderation.ts";

/* -------------------------------------------------------------- constants */

/** 2.5% per step, exactly 1/40. */
export const REFERRAL_RATE_DENOM = 40;
/** Steps up the chain that accrue. Beyond 6 the amounts are dust; see above. */
export const MAX_REFERRAL_DEPTH = 6;
/** Outstanding accruals older than this mark the payer "behind". */
export const SETTLEMENT_GRACE_MS = 60 * 24 * 60 * 60 * 1000;
/** Pairs owing less than a dollar never gate anything. Dust does not block. */
export const MIN_BLOCKING_OUTSTANDING_CENTS = 100;

/**
 * A named counterparty pending longer than this on a reporter's deal is
 * "chronically pending": the sock-participant shape the poison-pill hole rode
 * (a party who never confirms). Surfaced as a structure signal, never as an
 * automatic penalty; it is metadata for the operator and the upline to read.
 */
export const CHRONIC_PENDING_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a raised-but-unresolved dispute lifts the posting gate (H5). A
 * dispute is a request for a human to look, not a standing amnesty: past this
 * window the debt reverts to gating unless an operator has upheld it. See the
 * disputes region below.
 */
export const DISPUTE_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

export const MAX_SETTLEMENT_NOTE_LENGTH = 200;
export const MAX_SETTLEMENT_CENTS = 100_000_000_00; // $100M; above that, a bank.

/** Cents accrued to an ancestor at `depth` from a whole-dollar share. */
export function accrualCents(shareUsd: number, depth: number): number {
  return Math.round((shareUsd * 100) / Math.pow(REFERRAL_RATE_DENOM, depth));
}

/* ------------------------------------------ timely-recording fee credit (A)
 *
 * BUILDER 2 mechanism A, self-contained here so it does not tangle with the
 * base accrual arithmetic above (which builder 1 also reads). A confirmed
 * share earns a documented, capped reduction of the referral it owes up EVERY
 * step of its chain when BOTH of these hold:
 *
 *   1. TIMELY. The deal carried a reporter-stated close date (deal_close_dates)
 *      and it was recorded within TIMELY_RECORDING_WINDOW_MS of that date:
 *      |recorded_at - stated_close_at| <= window. The window is symmetric, so a
 *      far-future or far-past close date cannot buy the credit; only recording
 *      close to when you say the deal actually closed does.
 *   2. EVIDENCED. The earner committed an evidence hash on their OWN row
 *      (deal_participants.evidence_hash). Recording promptly is not enough; you
 *      also pin a document.
 *
 * When both hold the accrual to each ancestor is cut by TIMELY_EVIDENCE_CREDIT_BPS
 * (20%), floored at zero, rounded once per (share, ancestor) pair exactly like
 * the gross accrual. A deal with no close-date row, no evidence, or a late
 * recording earns nothing, so every pre-existing accrual (no such rows exist
 * before this feature) is unchanged. The credit is a carrot, never a penalty:
 * it can only lower what is owed, never raise it, and never below zero.
 */

/** Recording within this window of the stated close date is "timely". 14 days. */
export const TIMELY_RECORDING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** The referral cut a timely, evidenced share earns up its whole chain. 20%. */
export const TIMELY_EVIDENCE_CREDIT_BPS = 2000;

/**
 * The credit rate (basis points off the owed referral) an earning event earns,
 * 0 or TIMELY_EVIDENCE_CREDIT_BPS. Pure and deterministic: no clock, both
 * timestamps are stored. Null timestamps (a deal with no stated close date)
 * or missing evidence yield 0.
 */
export function recordingCreditBps(
  recordedAt: number | null,
  statedCloseAt: number | null,
  earnerCommittedEvidence: boolean,
): number {
  if (recordedAt == null || statedCloseAt == null) return 0;
  if (!earnerCommittedEvidence) return 0;
  if (Math.abs(recordedAt - statedCloseAt) > TIMELY_RECORDING_WINDOW_MS) return 0;
  return TIMELY_EVIDENCE_CREDIT_BPS;
}

/**
 * Accrual to an ancestor at `depth`, net of any timely-recording credit on the
 * event. Never above the gross accrual, never below zero. This is the figure
 * the ledger, the standing gate and the house floor all charge, so the credit
 * is applied in exactly one place and every surface agrees on what is owed.
 */
export function netAccrualCents(
  shareUsd: number,
  depth: number,
  creditBps: number,
): number {
  const gross = accrualCents(shareUsd, depth);
  if (creditBps <= 0) return gross;
  const credit = Math.floor((gross * Math.min(creditBps, 10000)) / 10000);
  return Math.max(0, gross - credit);
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

/* --------------------------------------------------------- the house / rake */

export type HouseAccount = { userId: string; username: string };

/**
 * The operator account that anchors the invite graph: the seed every chain
 * traces back to (marble-pennant, in this board). It is resolved, not
 * hard-coded, so a fork with a different origin still works: the invite-graph
 * ROOT is an inviter that is nobody's invitee, preferring one that also holds
 * the operator flag; failing any edges at all, the earliest operator. Null
 * only when there is neither an invite graph nor an operator, in which case
 * the house floor simply does not apply and no confirmed share is charged the
 * rake (there is nobody to charge it to).
 */
export async function operatorAccount(): Promise<HouseAccount | null> {
  const db = await getDb();
  const root = await db.execute(
    `SELECT u.id, u.username
       FROM invite_edges e
       JOIN users u ON u.id = e.inviter_id
      WHERE e.inviter_id NOT IN (SELECT user_id FROM invite_edges)
      GROUP BY u.id, u.username
      ORDER BY (SELECT COUNT(*) FROM operators o WHERE o.user_id = u.id) DESC,
               MIN(e.created_at) ASC
      LIMIT 1`,
  );
  if (root.rows[0]) {
    return { userId: String(root.rows[0].id), username: String(root.rows[0].username) };
  }
  const op = await db.execute(
    `SELECT u.id, u.username
       FROM operators o JOIN users u ON u.id = o.user_id
      ORDER BY o.granted_at ASC LIMIT 1`,
  );
  return op.rows[0]
    ? { userId: String(op.rows[0].id), username: String(op.rows[0].username) }
    : null;
}

/** A house node marked so the ledger and UI can label the depth-1 floor. */
export type EffectiveAncestor = ChainNode & { isHouse: boolean };

/**
 * Whom an earner's confirmed shares accrue up to, house floor included. The
 * human chain when it exists; otherwise, for a rootless account that is not
 * itself the house, a single synthetic depth-1 node for the operator: the
 * guaranteed 2.5% floor that keeps no confirmed share fee-free (H3). A short
 * human chain is returned as-is and NOT topped up to the house: only the
 * missing depth-1 increment is ever charged to the house, never a deeper tail.
 */
export async function effectiveAncestors(userId: string): Promise<EffectiveAncestor[]> {
  const ancestors = await ancestorChain(userId);
  if (ancestors.length > 0) {
    return ancestors.map((a) => ({ ...a, isHouse: false }));
  }
  const house = await operatorAccount();
  if (house && house.userId !== userId) {
    return [{ userId: house.userId, username: house.username, depth: 1, isHouse: true }];
  }
  return [];
}

/* ------------------------------------------------------ qualifying earnings */

/** One qualifying earning: a confirmed share on a co-attested-or-better deal. */
export type EarningEvent = {
  dealId: string;
  shareUsd: number;
  /** When the deal tipped to co-attested: its last confirmation timestamp. */
  accruedAt: number;
  /**
   * Timely-recording credit on THIS earner's share, basis points off the
   * referral owed up every step (0 or TIMELY_EVIDENCE_CREDIT_BPS). See
   * recordingCreditBps. Zero for every deal filed without a stated close date.
   */
  creditBps: number;
};

/**
 * Qualifying earnings for a set of accounts, one query. The predicate is the
 * SAME one the leaderboard credits reputation on (lib/stats.ts): a positive
 * CONFIRMED share on a deal where at least one named participant is confirmed.
 *
 * There is deliberately NO "and nobody is still pending" clause. That clause
 * was a fee-evasion hole: a single never-confirming sock participant kept the
 * deal permanently "has a pending party" and zeroed everyone's accrual on it,
 * while the leaderboard still credited the confirmed shares. Reputation and
 * fees have to fire on the same event, so accrual fires as soon as one
 * counterparty has signed, exactly as the self/other columns already do.
 * Zero-dollar shares are kept out; they accrue nothing and only pad the walk.
 */
export async function earningEventsFor(
  userIds: string[],
): Promise<Map<string, EarningEvent[]>> {
  const out = new Map<string, EarningEvent[]>();
  if (userIds.length === 0) return out;
  const db = await getDb();
  const placeholders = userIds.map(() => "?").join(", ");
  // The timely-recording credit (A) needs, per earning row: whether this earner
  // committed evidence (p.evidence_hash), and the deal's stated close date and
  // recorded_at (deal_close_dates, LEFT JOIN so deals without one still count,
  // just at zero credit). Nothing else about the credit leaves this query.
  const rs = await db.execute({
    sql: `SELECT p.user_id, p.share_usd, p.deal_id, p.evidence_hash,
                 dc.stated_close_at, dc.recorded_at,
                 (SELECT MAX(q.confirmed_at) FROM deal_participants q
                   WHERE q.deal_id = p.deal_id AND q.status = 'confirmed') AS attested_at
            FROM deal_participants p
            LEFT JOIN deal_close_dates dc ON dc.deal_id = p.deal_id
           WHERE p.user_id IN (${placeholders})
             AND p.status = 'confirmed'
             AND p.share_usd > 0
             AND EXISTS (SELECT 1 FROM deal_participants q
                          WHERE q.deal_id = p.deal_id AND q.role = 'participant'
                            AND q.status = 'confirmed')`,
    args: userIds,
  });
  for (const r of rs.rows) {
    const uid = String(r.user_id);
    const list = out.get(uid) ?? [];
    list.push({
      dealId: String(r.deal_id),
      shareUsd: Number(r.share_usd),
      accruedAt: Number(r.attested_at ?? 0),
      creditBps: recordingCreditBps(
        r.recorded_at == null ? null : Number(r.recorded_at),
        r.stated_close_at == null ? null : Number(r.stated_close_at),
        r.evidence_hash != null,
      ),
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
  /** What accrued to the viewer from those earnings, cents, net of any credit (A). */
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
  /** What the viewer owes this ancestor, cents, net of any timely-recording credit (A). */
  accruedCents: number;
  /** How much the timely-recording credit knocked off this row: gross - net (A). */
  creditedCents: number;
  settledCents: number;
  outstandingCents: number;
  disputed: boolean;
  settlements: SettlementRow[];
  /** FIFO: when the oldest not-yet-covered accrual landed. Null = covered. */
  oldestUnsettledAt: number | null;
  /** True for the operator house-floor row a rootless account owes (H3). */
  isHouse: boolean;
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
    cumulative += netAccrualCents(e.shareUsd, depth, e.creditBps);
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
    // Human chain, or the synthetic depth-1 house floor for a rootless
    // account (H3). Either way this is exactly whom the viewer's confirmed
    // shares accrue up to, so the mirror below reads it directly.
    effectiveAncestors(userId),
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
      (s, e) => s + netAccrualCents(e.shareUsd, d.depth, e.creditBps),
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
    const gross = myEvents.reduce(
      (s, e) => s + accrualCents(e.shareUsd, a.depth),
      0,
    );
    const accrued = myEvents.reduce(
      (s, e) => s + netAccrualCents(e.shareUsd, a.depth, e.creditBps),
      0,
    );
    const pairKey = `${userId}\x1f${a.userId}`;
    const settlements = settledByPair.get(pairKey) ?? [];
    const settled = sumSettled(settlements);
    return {
      username: a.username,
      depth: a.depth,
      accruedCents: accrued,
      creditedCents: Math.max(0, gross - accrued),
      settledCents: settled,
      outstandingCents: Math.max(0, accrued - settled),
      disputed: disputedPairs.has(pairKey),
      settlements,
      oldestUnsettledAt: oldestUncovered(myEvents, a.depth, settled),
      isHouse: a.isHouse,
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
 * Whether an account is behind on its referral obligations: some payee pair
 * has an outstanding balance of at least a dollar whose oldest uncovered
 * accrual is more than 60 days old, and the pair is not (actively) disputed.
 * The payees are the human ancestor chain, or, for a rootless account, the
 * single depth-1 house floor owed to the operator (H3): the empty-chain
 * short-circuit is gone, so a seed/grandfathered account that earns and never
 * settles the floor gates exactly like anyone else. A behind account cannot
 * post asks or record deals (the gates live in those routes); settling or
 * disputing lifts the block. Privilege-gating only: nothing here touches money.
 */
export async function settlementStanding(userId: string): Promise<SettlementStanding> {
  const db = await getDb();
  const events = (await earningEventsFor([userId])).get(userId) ?? [];
  if (events.length === 0) return { behind: false };

  const payees = await effectiveAncestors(userId);
  if (payees.length === 0) return { behind: false };

  const [settlementsRs, disputedPayees] = await Promise.all([
    db.execute({
      sql: `SELECT payee_id, SUM(amount_cents) AS settled
              FROM referral_settlements WHERE payer_id = ? GROUP BY payee_id`,
      args: [userId],
    }),
    // H5: only a dispute that CURRENTLY lifts the gate counts here (open and
    // inside its window, or upheld by an operator). A rejected dispute or one
    // whose window has lapsed drops out, so the debt reverts to gating. The
    // loop below is unchanged; it just consults a stricter set. A rootless
    // account can dispute its house pair the same way (raiseDispute below).
    activelyDisputedPayees(userId),
  ]);
  const settledByPayee = new Map(
    settlementsRs.rows.map((r) => [String(r.payee_id), Number(r.settled ?? 0)]),
  );

  const cutoff = now() - SETTLEMENT_GRACE_MS;
  const pairs: StandingPair[] = [];
  for (const a of payees) {
    if (disputedPayees.has(a.userId)) continue;
    const settled = settledByPayee.get(a.userId) ?? 0;
    const accrued = events.reduce(
      (s, e) => s + netAccrualCents(e.shareUsd, a.depth, e.creditBps),
      0,
    );
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
    // The one non-chain pair the ledger recognises: the depth-1 house floor a
    // rootless account owes the operator (H3). The operator, as payee, records
    // receipt against it exactly as a human ancestor would against a downline.
    const house = payerAncestors.length === 0 ? await operatorAccount() : null;
    const isHousePair =
      house != null && house.userId === payeeId && payerId !== payeeId;
    if (!isHousePair) return { ok: false, error: "not_in_chain" };
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
           WHERE id = ? AND payer_id = ? AND confirmed_by_payer = 0
           RETURNING amount_cents`,
    args: [settlementId, payerId],
  });
  if (upd.rows.length > 0) {
    // A mutually-confirmed referral settlement is a consequential, non-PII
    // event. Log it best-effort; the amount is bucketed to $10k (referral
    // fees are small, so effectively always "<$10k") and the subject is a
    // blinded settlement id, never who paid whom.
    const cents = Number(upd.rows[0].amount_cents ?? 0);
    await appendLeafBestEffort(
      { type: "referral_settled", subject: settlementId, totalUsd: Math.round(cents / 100) },
      { dedupKey: `referral_settled:${settlementId}` },
    );
    return { ok: true };
  }
  const rs = await db.execute({
    sql: `SELECT 1 FROM referral_settlements WHERE id = ? AND payer_id = ?`,
    args: [settlementId, payerId],
  });
  return rs.rows.length > 0
    ? { ok: false, error: "already_confirmed" }
    : { ok: false, error: "not_found" };
}

/* ------------------------------------------------------- house receivables */

/** One rootless earner and the depth-1 house floor they owe the operator. */
export type HouseReceivableRow = {
  username: string;
  lifetimeEarningsCents: number;
  accruedCents: number;
  settledCents: number;
  outstandingCents: number;
  disputed: boolean;
  settlements: SettlementRow[];
};

/**
 * The house floor as a receivable: rootless earners (no invite edge) and what
 * their confirmed shares owe the operator at the guaranteed 2.5% depth-1
 * floor (H3). These accounts are NOT in anyone's descendant tree, so they do
 * not appear in the ordinary downline; this is where the operator sees and
 * records against the rake. Empty for a caller who is not the house.
 */
export async function houseFloorReceivables(viewerId: string): Promise<HouseReceivableRow[]> {
  const db = await getDb();
  const house = await operatorAccount();
  if (!house || house.userId !== viewerId) return [];

  const rootlessRs = await db.execute({
    sql: `SELECT u.id, u.username
            FROM users u
           WHERE u.id <> ?
             AND NOT EXISTS (SELECT 1 FROM invite_edges e WHERE e.user_id = u.id)`,
    args: [house.userId],
  });
  const rootless = rootlessRs.rows.map((r) => ({
    id: String(r.id),
    username: String(r.username),
  }));
  if (rootless.length === 0) return [];

  const events = await earningEventsFor(rootless.map((r) => r.id));

  const [settlementsRs, disputesRs] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM referral_settlements WHERE payee_id = ? ORDER BY settled_at ASC`,
      args: [house.userId],
    }),
    db.execute({
      sql: `SELECT payer_id FROM referral_disputes WHERE payee_id = ?`,
      args: [house.userId],
    }),
  ]);
  const settledByPayer = new Map<string, SettlementRow[]>();
  for (const r of settlementsRs.rows) {
    const key = String(r.payer_id);
    const list = settledByPayer.get(key) ?? [];
    list.push(toSettlementRow(r));
    settledByPayer.set(key, list);
  }
  const disputedPayers = new Set(disputesRs.rows.map((r) => String(r.payer_id)));

  const out: HouseReceivableRow[] = [];
  for (const r of rootless) {
    const theirEvents = events.get(r.id) ?? [];
    if (theirEvents.length === 0) continue;
    const accrued = theirEvents.reduce(
      (s, e) => s + netAccrualCents(e.shareUsd, 1, e.creditBps),
      0,
    );
    const settlements = settledByPayer.get(r.id) ?? [];
    const settled = sumSettled(settlements);
    out.push({
      username: r.username,
      lifetimeEarningsCents: theirEvents.reduce((s, e) => s + e.shareUsd * 100, 0),
      accruedCents: accrued,
      settledCents: settled,
      outstandingCents: Math.max(0, accrued - settled),
      disputed: disputedPayers.has(r.id),
      settlements,
    });
  }
  out.sort((a, b) => b.outstandingCents - a.outstandingCents);
  return out;
}

/* -------------------------------------------------------- structure signals */

/**
 * Metadata-only structuring signals for one reporter, read straight off the
 * deals they filed. No dollars are revealed and no buyer is de-blinded: these
 * are ratios and counts an operator and an upline can read to see whether a
 * member is routing value off-ledger or leaning on never-confirming socks.
 */
export type StructureFlags = {
  username: string;
  /** Deals this account has reported (any tier). */
  reportedDeals: number;
  /**
   * Share of reported deal value that reached NO confirmed party: the mean of
   * (total - confirmed shares) / total across their deals, in basis points.
   * High means a lot of value is recorded as deals but allocated to nobody the
   * board can charge a fee on. 0..10000.
   */
  unallocatedRatioBps: number;
  /** Reported deals whose recorded shares sum to exactly the total. */
  exactSplitDeals: number;
  /** Distinct counterparties left pending past CHRONIC_PENDING_MS. */
  chronicallyPendingCounterparties: number;
};

function emptyFlags(username: string): StructureFlags {
  return {
    username,
    reportedDeals: 0,
    unallocatedRatioBps: 0,
    exactSplitDeals: 0,
    chronicallyPendingCounterparties: 0,
  };
}

/**
 * Structure flags for a set of accounts, keyed by user id. Two grouped
 * queries: one over each reporter's deals for the allocation ratios and exact
 * splits, one for chronically pending counterparties. Accounts that have
 * reported nothing come back as all-zero rows.
 */
export async function structureFlagsFor(
  userIds: string[],
): Promise<Map<string, StructureFlags>> {
  const out = new Map<string, StructureFlags>();
  if (userIds.length === 0) return out;
  const db = await getDb();
  const placeholders = userIds.map(() => "?").join(", ");

  const namesRs = await db.execute({
    sql: `SELECT id, username FROM users WHERE id IN (${placeholders})`,
    args: userIds,
  });
  for (const r of namesRs.rows) {
    out.set(String(r.id), emptyFlags(String(r.username)));
  }

  // Per-deal totals and recorded / confirmed allocations for these reporters.
  const dealsRs = await db.execute({
    sql: `SELECT d.reporter_id, d.total_usd,
                 IFNULL(SUM(p.share_usd), 0) AS recorded,
                 IFNULL(SUM(CASE WHEN p.status = 'confirmed' THEN p.share_usd ELSE 0 END), 0)
                   AS confirmed
            FROM deals d
            LEFT JOIN deal_participants p ON p.deal_id = d.id
           WHERE d.reporter_id IN (${placeholders})
           GROUP BY d.id`,
    args: userIds,
  });
  const ratioAcc = new Map<string, { unallocated: number; total: number }>();
  for (const r of dealsRs.rows) {
    const id = String(r.reporter_id);
    const total = Number(r.total_usd);
    const confirmed = Number(r.confirmed);
    const recorded = Number(r.recorded);
    const f = out.get(id) ?? emptyFlags(id);
    f.reportedDeals += 1;
    if (recorded === total) f.exactSplitDeals += 1;
    out.set(id, f);
    const acc = ratioAcc.get(id) ?? { unallocated: 0, total: 0 };
    acc.unallocated += Math.max(0, total - confirmed);
    acc.total += total;
    ratioAcc.set(id, acc);
  }
  for (const [id, acc] of ratioAcc) {
    const f = out.get(id);
    if (f && acc.total > 0) {
      f.unallocatedRatioBps = Math.round((acc.unallocated / acc.total) * 10000);
    }
  }

  // Chronically pending counterparties: distinct pending named parties on
  // deals these reporters filed more than CHRONIC_PENDING_MS ago.
  const chronicRs = await db.execute({
    sql: `SELECT d.reporter_id, COUNT(DISTINCT p.user_id) AS chronic
            FROM deals d
            JOIN deal_participants p ON p.deal_id = d.id
           WHERE d.reporter_id IN (${placeholders})
             AND p.role = 'participant'
             AND p.status = 'pending'
             AND d.created_at < ?
           GROUP BY d.reporter_id`,
    args: [...userIds, now() - CHRONIC_PENDING_MS],
  });
  for (const r of chronicRs.rows) {
    const f = out.get(String(r.reporter_id));
    if (f) f.chronicallyPendingCounterparties = Number(r.chronic);
  }

  return out;
}

/**
 * The viewer's own structure flags plus their downline's, for /invites. The
 * downline slice is the receivable-relevant part: an upline reads it to see
 * which of the members whose earnings accrue to them look like they are
 * structuring around the fee. Only members who have reported a deal are listed.
 */
export type StructureSignals = {
  self: StructureFlags;
  downline: StructureFlags[];
};

export async function structureSignalsFor(userId: string): Promise<StructureSignals> {
  const descendants = await descendantTree(userId);
  const ids = [userId, ...descendants.map((d) => d.userId)];
  const flags = await structureFlagsFor(ids);
  const self = flags.get(userId) ?? emptyFlags("");
  const downline = descendants
    .map((d) => flags.get(d.userId))
    .filter((f): f is StructureFlags => f != null && f.reportedDeals > 0);
  return { self, downline };
}

/* --------------------------------------------------------------- disputes */

/**
 * A dispute's lifecycle state. The absence of a referral_dispute_status row
 * means 'open'; an operator resolves it to 'upheld' (the disputer was right,
 * the pair's gate stays lifted) or 'rejected' (the debt stands, the gate
 * returns). See lib/referrals.ts's disputes region and the schema note on
 * referral_dispute_status.
 */
export type DisputeStatus = "open" | "upheld" | "rejected";

/** The parent dispute's identity as one path/id string: payer.payee. */
export function disputeId(payerId: string, payeeId: string): string {
  return `${payerId}.${payeeId}`;
}

/**
 * Split a disputeId back into its pair. User ids are prefixed base64url and
 * carry no dot, so the first dot is the separator. Null when malformed.
 */
export function parseDisputeId(id: string): { payerId: string; payeeId: string } | null {
  const dot = (id ?? "").indexOf(".");
  if (dot <= 0 || dot >= id.length - 1) return null;
  return { payerId: id.slice(0, dot), payeeId: id.slice(dot + 1) };
}

/**
 * Whether a dispute in this state lifts the posting gate right now. Upheld
 * lifts permanently; open lifts only inside the 45-day window; rejected (and
 * a lapsed open) does not lift, so the debt reverts to gating. This is the
 * whole of the H5 rule: raising is a bounded, resolvable pause, not amnesty.
 */
export function disputeLiftsGate(
  status: DisputeStatus,
  raisedAt: number,
  nowMs: number,
): boolean {
  if (status === "upheld") return true;
  if (status === "rejected") return false;
  return nowMs - raisedAt <= DISPUTE_WINDOW_MS;
}

/**
 * The payees (ancestors) whose dispute with `payerId` currently lifts the
 * gate. settlementStanding consults this and nothing else to decide which
 * pairs to skip; a dispute row that no longer lifts is simply absent here.
 */
export async function activelyDisputedPayees(payerId: string): Promise<Set<string>> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT d.payee_id, d.raised_at, s.status
            FROM referral_disputes d
            LEFT JOIN referral_dispute_status s
              ON s.dispute_id = d.payer_id || '.' || d.payee_id
           WHERE d.payer_id = ?`,
    args: [payerId],
  });
  const nowMs = now();
  const out = new Set<string>();
  for (const r of rs.rows) {
    const status = (r.status == null ? "open" : String(r.status)) as DisputeStatus;
    if (disputeLiftsGate(status, Number(r.raised_at), nowMs)) {
      out.add(String(r.payee_id));
    }
  }
  return out;
}

export type RaiseDisputeResult =
  | { ok: true }
  | { ok: false; error: "unknown_username" | "not_in_chain" | "already_disputed" };

/**
 * Either account on a pair can mark it disputed. The direction is derived,
 * not declared: the counterparty must be an ancestor or a descendant of the
 * caller within the depth cap. Raising lifts the payer's gate for a bounded
 * window (DISPUTE_WINDOW_MS) and flags the pair to operators. One dispute per
 * pair, ever (ON CONFLICT DO NOTHING): once a row exists a re-raise is
 * refused, so a rejected or resolved dispute cannot buy a fresh window. An
 * operator settles it for good via resolveDispute below.
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
    if (otherAncestors.some((a) => a.userId === callerId)) {
      payerId = otherId; // other owes up to caller
      payeeId = callerId;
    } else {
      // The house floor (H3): a rootless account and the operator can dispute
      // the depth-1 floor between them, in whichever direction the pair runs,
      // so a floor-gated seed account is never left unable to flag it.
      const house = await operatorAccount();
      if (
        house &&
        callerAncestors.length === 0 &&
        house.userId === otherId &&
        callerId !== otherId
      ) {
        payerId = callerId; // caller (rootless) owes the house
        payeeId = otherId;
      } else if (
        house &&
        otherAncestors.length === 0 &&
        house.userId === callerId &&
        callerId !== otherId
      ) {
        payerId = otherId; // other (rootless) owes the house (the caller)
        payeeId = callerId;
      } else {
        return { ok: false, error: "not_in_chain" };
      }
    }
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

/**
 * Open (unresolved) disputes, newest first, for the operator surfaces: the
 * read-only block on /invites and the /admin panel that adds uphold/reject.
 * Resolved pairs drop off. windowExpired marks an open dispute whose 45-day
 * gate lift has already lapsed, so it is gating again and wants a ruling.
 */
export type OpenDispute = {
  disputeId: string;
  payerUsername: string;
  payeeUsername: string;
  raisedByUsername: string;
  raisedAt: number;
  windowExpired: boolean;
};

export async function listOpenDisputes(): Promise<OpenDispute[]> {
  const db = await getDb();
  const rs = await db.execute(
    `SELECT d.payer_id, d.payee_id, d.raised_at,
            pu.username AS payer_username, yu.username AS payee_username,
            ru.username AS raised_by_username, s.status AS status
       FROM referral_disputes d
       JOIN users pu ON pu.id = d.payer_id
       JOIN users yu ON yu.id = d.payee_id
       JOIN users ru ON ru.id = d.raised_by
       LEFT JOIN referral_dispute_status s
         ON s.dispute_id = d.payer_id || '.' || d.payee_id
      WHERE s.status IS NULL OR s.status = 'open'
      ORDER BY d.raised_at DESC`,
  );
  const nowMs = now();
  return rs.rows.map((r) => {
    const raisedAt = Number(r.raised_at);
    return {
      disputeId: disputeId(String(r.payer_id), String(r.payee_id)),
      payerUsername: String(r.payer_username),
      payeeUsername: String(r.payee_username),
      raisedByUsername: String(r.raised_by_username),
      raisedAt,
      windowExpired: nowMs - raisedAt > DISPUTE_WINDOW_MS,
    };
  });
}

export type ResolveDisputeResult =
  | { ok: true; status: DisputeStatus }
  | {
      ok: false;
      error: "not_operator" | "not_found" | "bad_ruling" | "already_resolved";
    };

/**
 * An operator's ruling on a dispute. 'uphold' sides with the disputer and the
 * pair's gate stays lifted; 'reject' lets the debt stand and the gate
 * returns. First ruling wins, like a hide: a second resolve is refused rather
 * than overwriting the first operator's call. Operator-gated here as well as
 * at the route, so a flag revoked mid-request cannot land a ruling.
 */
export async function resolveDispute(
  operatorId: string,
  id: string,
  ruling: string,
): Promise<ResolveDisputeResult> {
  if (!(await isOperator(operatorId))) return { ok: false, error: "not_operator" };

  const status: DisputeStatus | null =
    ruling === "uphold" ? "upheld" : ruling === "reject" ? "rejected" : null;
  if (!status) return { ok: false, error: "bad_ruling" };

  const pair = parseDisputeId(id);
  if (!pair) return { ok: false, error: "not_found" };

  const db = await getDb();
  const exists = await db.execute({
    sql: `SELECT 1 FROM referral_disputes WHERE payer_id = ? AND payee_id = ?`,
    args: [pair.payerId, pair.payeeId],
  });
  if (exists.rows.length === 0) return { ok: false, error: "not_found" };

  const prior = await db.execute({
    sql: `SELECT 1 FROM referral_dispute_status WHERE dispute_id = ?`,
    args: [id],
  });
  if (prior.rows.length > 0) return { ok: false, error: "already_resolved" };

  try {
    await db.execute({
      sql: `INSERT INTO referral_dispute_status (dispute_id, status, resolved_at, resolved_by)
            VALUES (?, ?, ?, ?)`,
      args: [id, status, now(), operatorId],
    });
  } catch (err) {
    // PRIMARY KEY collision: another operator ruled between the check and the
    // write. Theirs stands.
    if (String(err).includes("referral_dispute_status")) {
      return { ok: false, error: "already_resolved" };
    }
    throw err;
  }
  return { ok: true, status };
}
