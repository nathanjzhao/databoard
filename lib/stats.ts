/**
 * lib/stats.ts
 *
 * Leaderboard arithmetic. Server-only, async, raw SQL over the same two
 * tables as lib/deals.ts, then plain math in process.
 *
 * Three metrics per account, computed from participant rows only:
 *
 *   collaborators   Reporter-side. Distinct CONFIRMED counterparties across
 *                   deals they reported, rate-limited: a given
 *                   reporter-counterparty pair counts at most once per 30
 *                   days no matter how many deals the pair confirms inside
 *                   the window. This is the default ranking because "who
 *                   keeps bringing new people in" is harder to fake than a
 *                   dollar figure you typed yourself.
 *
 *   valueToOthers   Reporter-side. Sum of CONFIRMED participants' shares on
 *                   deals they reported. Declined and pending shares are
 *                   worth nothing.
 *
 *   valueToSelf     Own share on deals they reported, counted ONLY once at
 *                   least one named participant has confirmed, plus their own
 *                   CONFIRMED shares on other people's deals. A SOLO deal (no
 *                   named participants) counts nothing here: a unilateral
 *                   claim is worth zero for reputation, the same as it is
 *                   worth zero for fees. This is the symmetry the referral
 *                   ledger depends on (lib/referrals.ts): the predicate that
 *                   grants reputation and the one that charges the fee are the
 *                   same, so no amount of solo recording buys standing.
 *
 *   claimedUnattested  A solo reporter's own share, summed separately. It is
 *                   surfaced, clearly labeled, so the board is honest that the
 *                   claim exists, but it sorts nothing and carries no rank.
 *
 * Plus a count of deals at evidence-committed tier the account is a
 * confirmed party to, for the badge column.
 *
 * PRIVACY / DISPLAY CONTRACT: the exact dollar sums computed here exist to
 * ORDER the board. They must never be serialized to a client. Everything
 * that leaves the server goes through toPublicLeaderboard(), which reduces
 * dollars to the nearest-$10k strings the leaderboard is allowed to show and
 * bakes each metric's ranking into plain integers, so the client can re-sort
 * without ever holding an exact figure.
 */

import { getDb } from "./db.ts";
import { deriveTier } from "./deals.ts";
import { usdRounded10k } from "../components/deals/format.ts";

/** A reporter-counterparty pair counts once per this window. */
export const PAIR_CAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type LeaderboardSortKey =
  | "collaborators"
  | "value_to_others"
  | "value_to_self";

/** One ranked account, exact figures included. Server-side only. */
export type LeaderboardRow = {
  userId: string;
  username: string;
  /** Metric (a). A count, not a dollar figure; displayable as-is. */
  collaborators: number;
  /** Metric (b), exact. Never serialize to a client. */
  valueToOthersUsd: number;
  /** Metric (c), exact. Never serialize to a client. */
  valueToSelfUsd: number;
  /** Solo claims, exact. Unranked; surfaced separately. Never serialize. */
  claimedUnattestedUsd: number;
  /** Deals at evidence-committed tier this account is a confirmed party to. */
  evidenceCommittedDeals: number;
  /** Earliest confirmation contributing to any metric. Breaks ties. */
  earliestConfirmedAt: number | null;
};

/** The whole computed board plus the aggregates the header tiles show. */
export type LeaderboardStats = {
  rows: LeaderboardRow[];
  /** Deals at co-attested tier or above. */
  coAttestedDeals: number;
  /** Distinct deals at evidence-committed tier. */
  evidenceCommittedDeals: number;
  /** Sum of every counted share, exact. Never serialize to a client. */
  attributedUsd: number;
  /** Board-wide sum of solo claims, exact. Unranked. Never serialize. */
  claimedUnattestedUsd: number;
};

/* ------------------------------------------------------------ computation */

type Row = {
  dealId: string;
  userId: string;
  username: string;
  role: "reporter" | "participant";
  shareUsd: number;
  status: "pending" | "confirmed" | "declined";
  confirmedAt: number | null;
  evidenceHash: string | null;
};

type Acc = {
  userId: string;
  username: string;
  /** counterparty user id -> confirmed_at timestamps on deals I reported */
  pairEvents: Map<string, number[]>;
  valueToOthersUsd: number;
  valueToSelfUsd: number;
  claimedUnattestedUsd: number;
  evidenceCommittedDeals: number;
  earliestConfirmedAt: number | null;
};

/**
 * Greedy once-per-window count: sort ascending, count a timestamp only when
 * it clears the last counted one by the full window. The same pair
 * confirming five deals in a week is one collaborator event; coming back
 * two months later is a second.
 */
function cappedEventCount(timestamps: number[]): number {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let count = 0;
  let lastCounted = Number.NEGATIVE_INFINITY;
  for (const t of sorted) {
    if (t >= lastCounted + PAIR_CAP_WINDOW_MS) {
      count += 1;
      lastCounted = t;
    }
  }
  return count;
}

function note(acc: Acc, t: number | null): void {
  if (t == null) return;
  if (acc.earliestConfirmedAt == null || t < acc.earliestConfirmedAt) {
    acc.earliestConfirmedAt = t;
  }
}

/**
 * The full board, exact figures and all. One pass over every participant
 * row; fine at this board's scale, and trivially cacheable later if it ever
 * is not.
 */
export async function computeLeaderboard(): Promise<LeaderboardStats> {
  const db = await getDb();
  const rs = await db.execute(
    `SELECT p.deal_id, p.user_id, p.role, p.share_usd, p.status,
            p.confirmed_at, p.evidence_hash, u.username
       FROM deal_participants p
       JOIN users u ON u.id = p.user_id`,
  );

  const byDeal = new Map<string, Row[]>();
  for (const r of rs.rows) {
    const row: Row = {
      dealId: String(r.deal_id),
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
    };
    const list = byDeal.get(row.dealId) ?? [];
    list.push(row);
    byDeal.set(row.dealId, list);
  }

  const accs = new Map<string, Acc>();
  const acc = (userId: string, username: string): Acc => {
    let a = accs.get(userId);
    if (!a) {
      a = {
        userId,
        username,
        pairEvents: new Map(),
        valueToOthersUsd: 0,
        valueToSelfUsd: 0,
        claimedUnattestedUsd: 0,
        evidenceCommittedDeals: 0,
        earliestConfirmedAt: null,
      };
      accs.set(userId, a);
    }
    return a;
  };

  let coAttestedDeals = 0;
  let evidenceCommittedDeals = 0;

  for (const rows of byDeal.values()) {
    const reporter = rows.find((r) => r.role === "reporter");
    if (!reporter) continue; // cannot happen; created atomically
    const named = rows.filter((r) => r.role === "participant");
    const confirmed = named.filter((r) => r.status === "confirmed");
    const solo = named.length === 0;

    const rep = acc(reporter.userId, reporter.username);

    // (a) pair events and (b) value to others: confirmed counterparties only.
    for (const p of confirmed) {
      rep.valueToOthersUsd += p.shareUsd;
      const events = rep.pairEvents.get(p.userId) ?? [];
      events.push(p.confirmedAt ?? 0);
      rep.pairEvents.set(p.userId, events);
      note(rep, p.confirmedAt);
    }

    // (c) reporter's own share: only once somebody has actually co-signed the
    // deal. A SOLO deal counts nothing toward the ranked self column; its
    // value goes to the unranked claimed-unattested tally instead, and it does
    // NOT note() a ranking timestamp, because it sorts nothing (H2).
    if (solo) {
      rep.claimedUnattestedUsd += reporter.shareUsd;
    } else if (confirmed.length > 0) {
      rep.valueToSelfUsd += reporter.shareUsd;
      note(
        rep,
        confirmed.reduce<number | null>(
          (m, p) =>
            p.confirmedAt == null ? m : m == null ? p.confirmedAt : Math.min(m, p.confirmedAt),
          null,
        ),
      );
    }

    // (c) each confirmed participant's own share on somebody else's deal.
    for (const p of confirmed) {
      const a = acc(p.userId, p.username);
      a.valueToSelfUsd += p.shareUsd;
      note(a, p.confirmedAt);
    }

    // Tier, via the same derivation the deal pages use.
    const tier = deriveTier(rows);
    if (tier === "co_attested" || tier === "evidence_committed") {
      coAttestedDeals += 1;
    }
    if (tier === "evidence_committed") {
      evidenceCommittedDeals += 1;
      for (const r of rows) {
        if (r.status === "confirmed") {
          acc(r.userId, r.username).evidenceCommittedDeals += 1;
        }
      }
    }
  }

  const rows: LeaderboardRow[] = [];
  let attributedUsd = 0;
  let claimedUnattestedUsd = 0;
  for (const a of accs.values()) {
    let collaborators = 0;
    for (const events of a.pairEvents.values()) {
      collaborators += cappedEventCount(events);
    }
    attributedUsd += a.valueToSelfUsd;
    // Board-wide unattested total counts every account's solo claims, whether
    // or not the account is otherwise ranked: the figure is honest about how
    // much unilateral claiming exists without ever ranking it.
    claimedUnattestedUsd += a.claimedUnattestedUsd;
    if (
      collaborators === 0 &&
      a.valueToOthersUsd === 0 &&
      a.valueToSelfUsd === 0 &&
      a.evidenceCommittedDeals === 0
    ) {
      continue; // nothing RANKED counted; a solo-only account is not on the board
    }
    rows.push({
      userId: a.userId,
      username: a.username,
      collaborators,
      valueToOthersUsd: a.valueToOthersUsd,
      valueToSelfUsd: a.valueToSelfUsd,
      claimedUnattestedUsd: a.claimedUnattestedUsd,
      evidenceCommittedDeals: a.evidenceCommittedDeals,
      earliestConfirmedAt: a.earliestConfirmedAt,
    });
  }

  rows.sort(compareBy("collaborators"));
  return {
    rows,
    coAttestedDeals,
    evidenceCommittedDeals,
    attributedUsd,
    claimedUnattestedUsd,
  };
}

/* ---------------------------------------------------------------- ranking */

function metricOf(row: LeaderboardRow, key: LeaderboardSortKey): number {
  switch (key) {
    case "collaborators":
      return row.collaborators;
    case "value_to_others":
      return row.valueToOthersUsd;
    case "value_to_self":
      return row.valueToSelfUsd;
  }
}

/**
 * Descending by the EXACT metric; ties go to the earlier confirmation (an
 * account that got there first outranks the one that tied it later), then
 * to the alphabet so the order is total and stable.
 */
function compareBy(key: LeaderboardSortKey) {
  return (a: LeaderboardRow, b: LeaderboardRow): number => {
    const d = metricOf(b, key) - metricOf(a, key);
    if (d !== 0) return d;
    const ae = a.earliestConfirmedAt ?? Number.POSITIVE_INFINITY;
    const be = b.earliestConfirmedAt ?? Number.POSITIVE_INFINITY;
    if (ae !== be) return ae - be;
    return a.username.localeCompare(b.username);
  };
}

/* ------------------------------------------------------ public projection */

/**
 * One row as the client is allowed to hold it: dollar figures already
 * reduced to nearest-$10k strings, and each metric's exact-sum ranking
 * flattened into a plain 1-based position so the table can re-sort by any
 * column without the exact numbers ever crossing the wire.
 */
export type PublicLeaderboardRow = {
  username: string;
  collaborators: number;
  valueToOthers: string;
  valueToSelf: string;
  /** Solo claims, rounded like every other figure. Sorts nothing; no rank. */
  claimedUnattested: string;
  evidenceCommittedDeals: number;
  ranks: Record<LeaderboardSortKey, number>;
};

export type PublicLeaderboard = {
  rows: PublicLeaderboardRow[];
  rankedAccounts: number;
  coAttestedDeals: number;
  evidenceCommittedDeals: number;
  /** Sum of every counted share, rounded like every other public figure. */
  attributedValue: string;
  /** Board-wide solo-claim total, rounded. Unranked; shown separately. */
  claimedUnattested: string;
};

export const SORT_KEYS: readonly LeaderboardSortKey[] = [
  "collaborators",
  "value_to_others",
  "value_to_self",
] as const;

export function toPublicLeaderboard(stats: LeaderboardStats): PublicLeaderboard {
  const ranks = new Map<string, Record<LeaderboardSortKey, number>>();
  for (const key of SORT_KEYS) {
    const ordered = [...stats.rows].sort(compareBy(key));
    ordered.forEach((row, i) => {
      const r =
        ranks.get(row.userId) ??
        ({ collaborators: 0, value_to_others: 0, value_to_self: 0 } as Record<
          LeaderboardSortKey,
          number
        >);
      r[key] = i + 1;
      ranks.set(row.userId, r);
    });
  }

  // Zero solo value must read as empty, not "<$10k": usdRounded10k cannot tell
  // "a small claim" from "no claim", so guard the zero before rounding.
  const claimStr = (n: number): string => (n > 0 ? usdRounded10k(n) : "");

  const rows: PublicLeaderboardRow[] = stats.rows.map((row) => ({
    username: row.username,
    collaborators: row.collaborators,
    valueToOthers: usdRounded10k(row.valueToOthersUsd),
    valueToSelf: usdRounded10k(row.valueToSelfUsd),
    claimedUnattested: claimStr(row.claimedUnattestedUsd),
    evidenceCommittedDeals: row.evidenceCommittedDeals,
    ranks: ranks.get(row.userId)!,
  }));

  return {
    rows,
    rankedAccounts: rows.length,
    coAttestedDeals: stats.coAttestedDeals,
    evidenceCommittedDeals: stats.evidenceCommittedDeals,
    attributedValue: usdRounded10k(stats.attributedUsd),
    claimedUnattested:
      stats.claimedUnattestedUsd > 0 ? usdRounded10k(stats.claimedUnattestedUsd) : "$0",
  };
}
