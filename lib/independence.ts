/**
 * lib/independence.ts
 *
 * Sybil-independence weighting for the leaderboard. Server-only, async, all
 * derived from invite_edges + deal_participants + users.created_at. No PII,
 * no de-blinding, no dollars: this file reads the invite genealogy and the
 * confirmation graph and decides ONE thing, per (reporter, confirmer) pair:
 * does a confirmation from that counterparty earn the reporter reputation, or
 * is the confirmer close enough in the reporter's own invite tree, and green
 * enough, that the reputation should be withheld until the confirmer proves
 * they transact with the outside world.
 *
 * THE RULE (documented on /transparency/verification and the leaderboard):
 *   A confirmation from a counterparty that is SYBIL-DEPENDENT on the reporter
 *   earns FULL fee accrual (fees are still owed, lib/referrals.ts is untouched)
 *   but ZERO collaborator and value-to-others credit for the reporter, until
 *   that confirmer has INDEPENDENT HISTORY.
 *
 *   Sybil-dependent(reporter R, confirmer C) is true when
 *     (a) C is a descendant of R in the invite tree (within the depth cap), OR
 *     (b) R and C share a NON-ROOT invite ancestor within N=2 hops: their 2-hop
 *         ancestor closures (each account plus up to two inviters above it)
 *         intersect on some account that is not itself a root. That catches
 *         siblings, cousins, an inviter and their invitee, an aunt and a niece:
 *         the shapes a single operator mints to confirm their own deals.
 *
 *   A ROOT (an account with no inviter: a seed, an operator, any top-level
 *   voucher) is EXCLUDED from the shared-ancestor test on purpose. A root
 *   vouches for many unrelated people, so two accounts whose only common
 *   ancestor is a root, two people the operator invited directly, are not
 *   sybils of each other, and treating them as such would discount most
 *   honest co-attestation on a small board where everyone traces to one seed.
 *   A hostile root that mints its own confirmers is outside this rule's reach
 *   by the same argument the co-attested section makes about cheap Sybils; the
 *   rule removes the reputation payoff for the subtree shape the graph can
 *   actually distinguish from normal vouching.
 *
 *   Independent history of C, relative to R's cluster, is true when
 *     (1) C's account is older than INDEPENDENCE_MIN_AGE_MS, AND
 *     (2) C is a confirmed party to at least one deal whose other confirmed
 *         parties are ALL outside R's sybil cluster. One real deal with a
 *         stranger is enough; a wall of deals inside the cluster is not.
 *
 * The fee half of the asymmetry lives in lib/referrals.ts and is deliberately
 * NOT changed here: a dependent confirmer still owes and still earns the
 * upline its fee. Reputation is the only thing withheld, so gaming visibility
 * with minted accounts costs exactly as much in fees as playing it straight,
 * and buys nothing until the minted account grows a real history.
 */

import { getDb } from "./db.ts";

/* ------------------------------------------------------------- constants */

/** Common-ancestor closeness for rule (b): 2 hops up, each side. */
export const SYBIL_COMMON_ANCESTOR_HOPS = 2;

/**
 * How deep the descendant test for rule (a) walks. Matches the referral
 * depth cap: past six invite steps the "subtree" is too diffuse to read as
 * one operator's cluster, and the fee tail is already dust.
 */
export const SYBIL_SUBTREE_MAX_DEPTH = 6;

/**
 * How old a dependent confirmer's account must be before independent history
 * can lift the discount. Two weeks: long enough that a same-day sock cannot
 * age its way out inside one recording session, short enough that a genuine
 * new member is not held back for long once they deal with an outsider.
 */
export const INDEPENDENCE_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------- invite graph */

/** The invite genealogy as an in-memory child->inviter map. */
export type InviteGraph = {
  /** user_id -> inviter_id, one entry per invite_edges row. */
  parentOf: Map<string, string>;
};

/** Load invite_edges once into a parent map. Accounts with no edge are roots. */
export async function loadInviteGraph(): Promise<InviteGraph> {
  const db = await getDb();
  const rs = await db.execute(`SELECT user_id, inviter_id FROM invite_edges`);
  const parentOf = new Map<string, string>();
  for (const r of rs.rows) {
    parentOf.set(String(r.user_id), String(r.inviter_id));
  }
  return { parentOf };
}

/** A root is an account with no inviter: a seed, an operator, a top-level voucher. */
export function isRoot(graph: InviteGraph, userId: string): boolean {
  return !graph.parentOf.has(userId);
}

/* ------------------------------------------------------- graph predicates */

/**
 * The account plus up to `hops` inviters above it. A seen-set guards against
 * a hand-crafted cycle in invite_edges ever looping the walk.
 */
export function closureUpTo(graph: InviteGraph, userId: string, hops: number): Set<string> {
  const out = new Set<string>([userId]);
  let current = userId;
  for (let i = 0; i < hops; i++) {
    const parent = graph.parentOf.get(current);
    if (parent == null || out.has(parent)) break;
    out.add(parent);
    current = parent;
  }
  return out;
}

/**
 * Whether `node` is a descendant of `ancestor` within `maxDepth` invite hops:
 * walk up from node, up to maxDepth steps, and report whether ancestor is met.
 */
export function isDescendant(
  graph: InviteGraph,
  ancestor: string,
  node: string,
  maxDepth: number,
): boolean {
  if (ancestor === node) return false;
  const seen = new Set<string>([node]);
  let current = node;
  for (let i = 0; i < maxDepth; i++) {
    const parent = graph.parentOf.get(current);
    if (parent == null) return false;
    if (parent === ancestor) return true;
    if (seen.has(parent)) return false;
    seen.add(parent);
    current = parent;
  }
  return false;
}

/**
 * Whether C is in R's sybil cluster: C IS R, or C descends from R, or the two
 * share an invite ancestor within N=2 hops (their 2-hop closures intersect).
 * Identity counts so the disjoint-deal test treats "a deal with R" as inside
 * the cluster.
 */
export function isSybilRelated(graph: InviteGraph, r: string, c: string): boolean {
  if (r === c) return true;
  if (isDescendant(graph, r, c, SYBIL_SUBTREE_MAX_DEPTH)) return true;
  const cr = closureUpTo(graph, r, SYBIL_COMMON_ANCESTOR_HOPS);
  const cc = closureUpTo(graph, c, SYBIL_COMMON_ANCESTOR_HOPS);
  // Intersect on a shared NON-ROOT ancestor only. A root vouches broadly, so
  // sharing one is not sybil evidence (see the module header).
  for (const a of cc) if (cr.has(a) && !isRoot(graph, a)) return true;
  return false;
}

/** Sybil-related but not the same account: the dependency rule's antecedent. */
export function isSybilDependent(graph: InviteGraph, r: string, c: string): boolean {
  return r !== c && isSybilRelated(graph, r, c);
}

/* ------------------------------------------------- independence context */

/**
 * Everything the independence test reads, gathered once so the per-pair check
 * stays a pure function of in-memory data. stats.ts already loads the deal
 * rows and can build confirmedPeers from them; graph-signals builds its own.
 */
export type IndependenceContext = {
  graph: InviteGraph;
  /** user_id -> account created_at (ms). */
  createdAt: Map<string, number>;
  /**
   * user_id -> for each deal the user is a CONFIRMED party to, the ids of the
   * OTHER confirmed parties on that deal. One inner array per qualifying deal.
   */
  confirmedPeers: Map<string, string[][]>;
  /** Evaluation clock; passed in so tests are deterministic. */
  now: number;
};

/**
 * Independent history of confirmer C relative to reporter R's sybil cluster:
 * old enough AND a confirmed party to at least one deal whose other confirmed
 * parties are all outside R's cluster. An empty peer list on a deal (C had no
 * confirmed counterparty) never counts: independence is proven by dealing with
 * someone, not by soloing.
 */
export function hasIndependentHistory(
  ctx: IndependenceContext,
  confirmerId: string,
  reporterId: string,
): boolean {
  const created = ctx.createdAt.get(confirmerId);
  if (created == null || ctx.now - created < INDEPENDENCE_MIN_AGE_MS) return false;
  const deals = ctx.confirmedPeers.get(confirmerId) ?? [];
  for (const peers of deals) {
    if (peers.length === 0) continue;
    if (peers.every((p) => !isSybilRelated(ctx.graph, reporterId, p))) return true;
  }
  return false;
}

/**
 * The whole rule in one call: a confirmation from C on a deal reported by R is
 * DISCOUNTED (zero collaborator + value-to-others credit for R) when C is
 * sybil-dependent on R and has not yet earned independent history. Returns
 * false, so the confirmation counts in full, whenever the invite graph does
 * not tie the two together.
 */
export function isDiscountedConfirmer(
  ctx: IndependenceContext,
  reporterId: string,
  confirmerId: string,
): boolean {
  if (!isSybilDependent(ctx.graph, reporterId, confirmerId)) return false;
  return !hasIndependentHistory(ctx, confirmerId, reporterId);
}
