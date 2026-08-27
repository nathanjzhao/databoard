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
 *                   deals they reported, TIER-WEIGHTED (evidence-committed at
 *                   1.0, co-attested at 0.5; see tierValueWeight). A
 *                   confirmation from a sybil-dependent counterparty with no
 *                   independent history (lib/independence.ts) is skipped
 *                   entirely here. Declined and pending shares are worth
 *                   nothing.
 *
 *   valueToSelf     Own share on deals they reported, counted ONLY once at
 *                   least one named participant has confirmed, plus their own
 *                   CONFIRMED shares on other people's deals, all TIER-WEIGHTED
 *                   the same way. A SOLO deal (no named participants) counts
 *                   nothing here: a unilateral claim is worth zero for
 *                   reputation, the same as it is worth zero for fees. This is
 *                   the symmetry the referral ledger depends on
 *                   (lib/referrals.ts): the predicate that grants reputation
 *                   and the one that charges the fee are the same, so no amount
 *                   of solo recording buys standing. The tier weight and the
 *                   sybil discount change how much a counted dollar is WORTH
 *                   for reputation, never whether the fee on it is owed.
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

import { getDb, now } from "./db.ts";
import { deriveTier, type DealTier } from "./deals.ts";
import { usdRounded10k } from "../components/deals/format.ts";
import {
  loadInviteGraph,
  isDiscountedConfirmer,
  type IndependenceContext,
} from "./independence.ts";

/** A reporter-counterparty pair counts once per this window. */
export const PAIR_CAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------- tier weights */

/**
 * How much a counted dollar is worth for REPUTATION, by how far the deal
 * carrying it climbed the ladder. This is a reputation weight only: it never
 * touches the referral fee (lib/referrals.ts charges the full confirmed share
 * at every tier), so a co-attested dollar owes exactly what an
 * evidence-committed dollar owes and is simply worth less standing.
 *
 *   evidence_committed  1.0   the reporter and every confirmed party each
 *                             committed a document hash; a dollar somebody
 *                             bothered to evidence-commit outranks a bare
 *                             self-report.
 *   co_attested         0.5   confirmed by a counterparty, no hashes yet (or
 *                             a party still pending): it counts, at a discount.
 *   claimed / solo      0     no counterparty signed; worth nothing for
 *                             reputation, the same as it is worth nothing for
 *                             fees.
 */
export const WEIGHT_EVIDENCE_COMMITTED = 1.0;
export const WEIGHT_CO_ATTESTED = 0.5;

/**
 * The reputation weight a deal's counted shares carry. Zero unless at least
 * one named counterparty confirmed (the exact predicate that makes a share
 * count at all, and the one the fee fires on), so the weighting never zeroes a
 * dollar that the fee still charges: it only splits the counting dollars into
 * full-weight evidence-committed and half-weight co-attested. A deal with a
 * still-pending named party is not yet evidence_committed even if its
 * confirmed parties committed hashes, so it earns the co-attested weight until
 * it fully settles, exactly as its tier badge reads.
 */
export function tierValueWeight(
  rows: readonly {
    role: "reporter" | "participant";
    status: "pending" | "confirmed" | "declined";
    evidenceHash: string | null;
  }[],
): number {
  const named = rows.filter((r) => r.role === "participant");
  const confirmed = named.filter((r) => r.status === "confirmed");
  if (confirmed.length === 0) return 0;
  const tier: DealTier = deriveTier(rows);
  return tier === "evidence_committed" ? WEIGHT_EVIDENCE_COMMITTED : WEIGHT_CO_ATTESTED;
}

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
            p.confirmed_at, p.evidence_hash, u.username, u.created_at
       FROM deal_participants p
       JOIN users u ON u.id = p.user_id`,
  );

  const byDeal = new Map<string, Row[]>();
  // Account ages, for the sybil-independence test (lib/independence.ts).
  const createdAt = new Map<string, number>();
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
    createdAt.set(row.userId, Number(r.created_at));
    const list = byDeal.get(row.dealId) ?? [];
    list.push(row);
    byDeal.set(row.dealId, list);
  }

  // The sybil-independence context: the invite graph, account ages, and, for
  // every account, the confirmed parties it has co-signed a deal with. The
  // last is built straight from byDeal so the per-pair discount check below
  // is a pure lookup and no extra query is needed.
  const confirmedPeers = new Map<string, string[][]>();
  for (const rows of byDeal.values()) {
    const confirmedIds = rows.filter((r) => r.status === "confirmed").map((r) => r.userId);
    for (const id of confirmedIds) {
      const peers = confirmedIds.filter((other) => other !== id);
      const list = confirmedPeers.get(id) ?? [];
      list.push(peers);
      confirmedPeers.set(id, list);
    }
  }
  const independence: IndependenceContext = {
    graph: await loadInviteGraph(),
    createdAt,
    confirmedPeers,
    now: now(),
  };

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

    // The reputation weight for every dollar this deal contributes: 1.0 at
    // evidence-committed, 0.5 at co-attested, 0 with no confirmed counterparty.
    const weight = tierValueWeight(rows);

    // (a) pair events and (b) value to others: confirmed counterparties only,
    // tier-weighted. A confirmer that is sybil-dependent on the reporter and
    // has not yet earned independent history is DISCOUNTED here: zero
    // collaborator and value-to-others credit for the reporter. The fee on
    // that same share is untouched (lib/referrals.ts), so a minted-account
    // confirmation still costs the reporter its fee and now buys no standing.
    for (const p of confirmed) {
      if (isDiscountedConfirmer(independence, reporter.userId, p.userId)) continue;
      rep.valueToOthersUsd += p.shareUsd * weight;
      const events = rep.pairEvents.get(p.userId) ?? [];
      events.push(p.confirmedAt ?? 0);
      rep.pairEvents.set(p.userId, events);
      note(rep, p.confirmedAt);
    }

    // (c) reporter's own share: only once somebody has actually co-signed the
    // deal, tier-weighted. A SOLO deal counts nothing toward the ranked self
    // column; its value goes to the unranked claimed-unattested tally instead,
    // and it does NOT note() a ranking timestamp, because it sorts nothing
    // (H2). Self value is the reporter's own money and is not sybil-discounted:
    // the discount withholds credit for OTHER people's confirmations, not the
    // reporter's own share.
    if (solo) {
      rep.claimedUnattestedUsd += reporter.shareUsd;
    } else if (confirmed.length > 0) {
      rep.valueToSelfUsd += reporter.shareUsd * weight;
      note(
        rep,
        confirmed.reduce<number | null>(
          (m, p) =>
            p.confirmedAt == null ? m : m == null ? p.confirmedAt : Math.min(m, p.confirmedAt),
          null,
        ),
      );
    }

    // (c) each confirmed participant's own share on somebody else's deal,
    // tier-weighted. Own share again, so no sybil discount applies.
    for (const p of confirmed) {
      const a = acc(p.userId, p.username);
      a.valueToSelfUsd += p.shareUsd * weight;
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

  // Default order is the network-contribution headline (value brought to
  // others), matching the leaderboard's default column. The client re-sorts by
  // any column from the per-metric ranks, so this only sets the initial view.
  rows.sort(compareBy("value_to_others"));
  return {
    rows,
    coAttestedDeals,
    evidenceCommittedDeals,
    attributedUsd,
    claimedUnattestedUsd,
  };
}

/* ------------------------------------------------ recorded-volume buckets */

/**
 * One account's recorded attested volume, exact. Server-side only, like every
 * other dollar figure in this module: the matching layer buckets it before a
 * single number reaches a client.
 */
export type RecordedVolume = {
  /** Sum of this account's own CONFIRMED shares on co-attested-or-better deals. */
  volumeUsd: number;
  /** Distinct such deals on which this account's own row also carries an evidence hash. */
  evidenceBackedDeals: number;
};

/**
 * Recorded attested volume per account, one query, for the matching-priority
 * layer. The predicate is DELIBERATELY the exact one the referral fee accrues
 * on (lib/referrals.ts earningEventsFor) and the leaderboard credits self value
 * on: a positive CONFIRMED share on a deal where at least one named participant
 * is confirmed. Same event grants priority, reputation, and the fee, so the
 * volume that raises an account's visibility is exactly the volume that has
 * already paid: gaming priority means paying.
 *
 * Returns exact figures. They exist only to bucket, and must never be
 * serialized to a client; recordedVolumeChip() / comparePriority() in
 * lib/matching.ts are the only things that consume them, and only the coarse
 * bucket ever leaves the server.
 */
export async function recordedVolumeByUser(
  userIds: string[],
): Promise<Map<string, RecordedVolume>> {
  const out = new Map<string, RecordedVolume>();
  if (userIds.length === 0) return out;
  const db = await getDb();
  const placeholders = userIds.map(() => "?").join(", ");
  const rs = await db.execute({
    sql: `SELECT p.user_id AS user_id,
                 SUM(p.share_usd) AS volume_usd,
                 COUNT(DISTINCT CASE WHEN p.evidence_hash IS NOT NULL
                                     THEN p.deal_id END) AS evidence_deals
            FROM deal_participants p
           WHERE p.user_id IN (${placeholders})
             AND p.status = 'confirmed'
             AND p.share_usd > 0
             AND EXISTS (SELECT 1 FROM deal_participants q
                          WHERE q.deal_id = p.deal_id AND q.role = 'participant'
                            AND q.status = 'confirmed')
           GROUP BY p.user_id`,
    args: userIds,
  });
  for (const r of rs.rows) {
    out.set(String(r.user_id), {
      volumeUsd: Number(r.volume_usd ?? 0),
      evidenceBackedDeals: Number(r.evidence_deals ?? 0),
    });
  }
  return out;
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
