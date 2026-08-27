/**
 * lib/graph-signals.ts
 *
 * Operator-visible graph analytics. Server-only, async, all computed from
 * already-stored metadata: invite_edges, deals, deal_participants, asks,
 * users.created_at. No amounts beyond the same nearest-$10k buckets the
 * leaderboard uses, no buyer de-blinding, no PII beyond the usernames the
 * board already shows everyone.
 *
 * Three signatures, each a RANKED LIST for a human to read, with the counts
 * that put a row on it. THESE ARE RISK SIGNALS, NOT PENALTIES: nothing here
 * hides an ask, gates a poster, or docks reputation. They point an operator at
 * shapes worth a look, and the /admin panel says exactly that.
 *
 *   FEE-SINK          accounts named on many deals with large recorded shares
 *                     that also sit at or near the invite root (a short
 *                     ancestor chain). Value pooling high in the tree, where
 *                     the whole downline's fees also flow, is worth a look.
 *   SOCK              fresh accounts whose only activity is confirming one
 *                     reporter's deals: no deals of their own, no asks, and
 *                     every confirmation points at the same reporter.
 *   REMAINDER OUTLIER reporters with a high ratio of unallocated remainder to
 *                     deal total, or a run of deals whose shares sum to exactly
 *                     the total. Both are what routing value off the fee looks
 *                     like from the outside.
 */

import { getDb, now } from "./db.ts";
import {
  loadInviteGraph,
  isSybilRelated,
  SYBIL_SUBTREE_MAX_DEPTH,
  type InviteGraph,
} from "./independence.ts";
import { structureFlagsFor } from "./referrals.ts";
import { usdRounded10k } from "../components/deals/format.ts";

/* ------------------------------------------------------------- thresholds */

/** Fee-sink: how short an ancestor chain reads as "at or near the root". */
export const FEE_SINK_MAX_DEPTH = 2;
/** Fee-sink: a row needs at least this many confirmed deals to be worth flagging. */
export const FEE_SINK_MIN_DEALS = 2;
/** Sock: accounts younger than this are "fresh". */
export const SOCK_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
/** Remainder outlier: unallocated share of total this high (bps) flags a row. */
export const REMAINDER_HIGH_BPS = 5000;
/** Remainder outlier: this many exact-split deals flags a row on its own. */
export const REMAINDER_MIN_EXACT = 2;

/** Default rows per signature. */
export const DEFAULT_SIGNAL_LIMIT = 20;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SIGNAL_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

/* -------------------------------------------------------------- ancestry */

/**
 * How many invite hops separate an account from its root: 0 for a root
 * account (no invite edge), 1 for a direct invitee, and so on, capped at the
 * subtree depth so a pathological chain cannot run the walk forever.
 */
export function ancestorDepth(graph: InviteGraph, userId: string): number {
  let depth = 0;
  let current = userId;
  const seen = new Set<string>([userId]);
  while (depth < SYBIL_SUBTREE_MAX_DEPTH) {
    const parent = graph.parentOf.get(current);
    if (parent == null || seen.has(parent)) break;
    depth += 1;
    seen.add(parent);
    current = parent;
  }
  return depth;
}

/* -------------------------------------------------------------- FEE-SINK */

export type FeeSinkRow = {
  username: string;
  /** Distinct deals this account is a confirmed party to. */
  dealsNamedOn: number;
  /** This account's confirmed recorded volume, bucketed to nearest $10k. */
  recordedShareBucket: string;
  /** Invite hops to the root. 0 means a root account. */
  ancestorDepth: number;
  /** True when the account sits at the invite root (no inviter). */
  isRoot: boolean;
};

/**
 * Accounts pooling value at or near the invite root. Confirmed recorded volume
 * and deal count come from deal_participants; the ancestor chain from the
 * invite graph. A row qualifies when its chain is at most FEE_SINK_MAX_DEPTH
 * and it is a confirmed party to at least FEE_SINK_MIN_DEALS deals; ranked by
 * exact volume then deal count, and only the bucket ever leaves the server.
 */
export async function feeSinkSignals(
  graph: InviteGraph,
  limit = DEFAULT_SIGNAL_LIMIT,
): Promise<FeeSinkRow[]> {
  const db = await getDb();
  const rs = await db.execute(
    `SELECT p.user_id AS user_id, u.username AS username,
            COUNT(DISTINCT p.deal_id) AS deals,
            IFNULL(SUM(p.share_usd), 0) AS volume
       FROM deal_participants p
       JOIN users u ON u.id = p.user_id
      WHERE p.status = 'confirmed' AND p.share_usd > 0
      GROUP BY p.user_id`,
  );

  const rows: (FeeSinkRow & { volumeUsd: number })[] = [];
  for (const r of rs.rows) {
    const userId = String(r.user_id);
    const deals = Number(r.deals);
    if (deals < FEE_SINK_MIN_DEALS) continue;
    const depth = ancestorDepth(graph, userId);
    if (depth > FEE_SINK_MAX_DEPTH) continue;
    const volumeUsd = Number(r.volume);
    rows.push({
      username: String(r.username),
      dealsNamedOn: deals,
      recordedShareBucket: usdRounded10k(volumeUsd),
      ancestorDepth: depth,
      isRoot: depth === 0,
      volumeUsd,
    });
  }
  rows.sort((a, b) => b.volumeUsd - a.volumeUsd || b.dealsNamedOn - a.dealsNamedOn);
  return rows.slice(0, clampLimit(limit)).map(({ volumeUsd: _v, ...row }) => row);
}

/* ------------------------------------------------------------------ SOCK */

export type SockRow = {
  username: string;
  /** Account age in whole days. */
  ageDays: number;
  /** Confirmed participations, all pointing at one reporter. */
  confirmations: number;
  /** The single reporter every confirmation lands on. */
  soleReporterUsername: string;
  /** True when the sock also sits in that reporter's own invite cluster. */
  sybilRelatedToReporter: boolean;
};

/**
 * Fresh accounts whose only footprint is confirming one reporter's deals: no
 * deals reported, no asks posted, every confirmation on a single reporter's
 * deals. Age from users.created_at; the rest from grouped counts. Ranked by
 * confirmation count. sybilRelatedToReporter adds whether the account is even
 * in that reporter's invite cluster (lib/independence.ts), which is the
 * difference between a new member who only confirmed one partner so far and a
 * minted account inside the reporter's own tree.
 */
export async function sockSignals(
  graph: InviteGraph,
  limit = DEFAULT_SIGNAL_LIMIT,
): Promise<SockRow[]> {
  const db = await getDb();
  const nowMs = now();
  const freshCutoff = nowMs - SOCK_MAX_AGE_MS;

  const [usersRs, confirmsRs, reportedRs, asksRs] = await Promise.all([
    db.execute({
      sql: `SELECT id, username, created_at FROM users WHERE created_at >= ?`,
      args: [freshCutoff],
    }),
    db.execute(
      `SELECT p.user_id AS user_id, d.reporter_id AS reporter_id, COUNT(*) AS n
         FROM deal_participants p
         JOIN deals d ON d.id = p.deal_id
        WHERE p.role = 'participant' AND p.status = 'confirmed'
        GROUP BY p.user_id, d.reporter_id`,
    ),
    db.execute(`SELECT reporter_id, COUNT(*) AS n FROM deals GROUP BY reporter_id`),
    db.execute(`SELECT user_id, COUNT(*) AS n FROM asks GROUP BY user_id`),
  ]);

  const reportedBy = new Map<string, number>();
  for (const r of reportedRs.rows) reportedBy.set(String(r.reporter_id), Number(r.n));
  const asksBy = new Map<string, number>();
  for (const r of asksRs.rows) asksBy.set(String(r.user_id), Number(r.n));

  // Per confirmer: total confirmations, distinct reporters, and (when there is
  // exactly one) which reporter.
  type Agg = { total: number; reporters: Map<string, number> };
  const byUser = new Map<string, Agg>();
  for (const r of confirmsRs.rows) {
    const uid = String(r.user_id);
    const rep = String(r.reporter_id);
    const n = Number(r.n);
    const agg = byUser.get(uid) ?? { total: 0, reporters: new Map() };
    agg.total += n;
    agg.reporters.set(rep, (agg.reporters.get(rep) ?? 0) + n);
    byUser.set(uid, agg);
  }

  const reporterName = new Map<string, string>();
  {
    // Names for the sole reporters we are about to surface.
    const need = new Set<string>();
    for (const agg of byUser.values()) {
      if (agg.reporters.size === 1) need.add([...agg.reporters.keys()][0]);
    }
    if (need.size > 0) {
      const ids = [...need];
      const placeholders = ids.map(() => "?").join(", ");
      const nameRs = await db.execute({
        sql: `SELECT id, username FROM users WHERE id IN (${placeholders})`,
        args: ids,
      });
      for (const r of nameRs.rows) reporterName.set(String(r.id), String(r.username));
    }
  }

  const rows: (SockRow & { confirmations: number })[] = [];
  for (const r of usersRs.rows) {
    const uid = String(r.id);
    const agg = byUser.get(uid);
    if (!agg || agg.total === 0) continue; // no confirmations: not a sock
    if (agg.reporters.size !== 1) continue; // spread across reporters: not a sock
    if ((reportedBy.get(uid) ?? 0) > 0) continue; // reports its own deals
    if ((asksBy.get(uid) ?? 0) > 0) continue; // posts asks
    const reporterId = [...agg.reporters.keys()][0];
    const ageDays = Math.floor((nowMs - Number(r.created_at)) / (24 * 60 * 60 * 1000));
    rows.push({
      username: String(r.username),
      ageDays,
      confirmations: agg.total,
      soleReporterUsername: reporterName.get(reporterId) ?? "gone",
      sybilRelatedToReporter: isSybilRelated(graph, reporterId, uid),
    });
  }
  rows.sort((a, b) => b.confirmations - a.confirmations);
  return rows.slice(0, clampLimit(limit));
}

/* ------------------------------------------------------- REMAINDER OUTLIER */

export type RemainderOutlierRow = {
  username: string;
  reportedDeals: number;
  /** Mean unallocated share of deal total, in basis points (0..10000). */
  unallocatedRatioBps: number;
  /** Reported deals whose recorded shares sum to exactly the total. */
  exactSplitDeals: number;
};

/**
 * Reporters whose deals leak value away from anyone the board can charge, or
 * whose splits land on the total exactly a suspicious number of times. Both
 * ratios come straight from lib/referrals.ts structureFlagsFor, the same
 * metadata-only computation /invites already shows a member about their own
 * downline; this ranks it across every reporter for the operator. A row
 * qualifies at REMAINDER_HIGH_BPS unallocated OR REMAINDER_MIN_EXACT exact
 * splits, ranked by unallocated ratio then exact-split count.
 */
export async function remainderOutlierSignals(
  limit = DEFAULT_SIGNAL_LIMIT,
): Promise<RemainderOutlierRow[]> {
  const db = await getDb();
  const reportersRs = await db.execute(`SELECT DISTINCT reporter_id FROM deals`);
  const reporterIds = reportersRs.rows.map((r) => String(r.reporter_id));
  if (reporterIds.length === 0) return [];

  const flags = await structureFlagsFor(reporterIds);
  const rows: RemainderOutlierRow[] = [];
  for (const f of flags.values()) {
    if (f.reportedDeals === 0) continue;
    const qualifies =
      f.unallocatedRatioBps >= REMAINDER_HIGH_BPS ||
      f.exactSplitDeals >= REMAINDER_MIN_EXACT;
    if (!qualifies) continue;
    rows.push({
      username: f.username,
      reportedDeals: f.reportedDeals,
      unallocatedRatioBps: f.unallocatedRatioBps,
      exactSplitDeals: f.exactSplitDeals,
    });
  }
  rows.sort(
    (a, b) =>
      b.unallocatedRatioBps - a.unallocatedRatioBps ||
      b.exactSplitDeals - a.exactSplitDeals,
  );
  return rows.slice(0, clampLimit(limit));
}

/* ---------------------------------------------------------------- combined */

export type GraphSignals = {
  feeSink: FeeSinkRow[];
  sock: SockRow[];
  remainderOutlier: RemainderOutlierRow[];
  /** When the signals were computed, for the panel's freshness line. */
  generatedAt: number;
};

/** All three signatures in one call, sharing one loaded invite graph. */
export async function computeGraphSignals(
  limit = DEFAULT_SIGNAL_LIMIT,
): Promise<GraphSignals> {
  const graph = await loadInviteGraph();
  const [feeSink, sock, remainderOutlier] = await Promise.all([
    feeSinkSignals(graph, limit),
    sockSignals(graph, limit),
    remainderOutlierSignals(limit),
  ]);
  return { feeSink, sock, remainderOutlier, generatedAt: now() };
}
