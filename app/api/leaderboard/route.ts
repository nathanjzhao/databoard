/**
 * GET /api/leaderboard
 *
 * The standings, members only, in the PUBLIC projection and nothing else:
 * dollar columns arrive as nearest-$10k strings and each metric's ordering
 * as a plain 1-based rank. The exact sums that produced the order never
 * leave lib/stats.ts, so there is no exact figure here to leak, cache, or
 * scrape.
 *
 * Reply: { rows, rankedAccounts, coAttestedDeals, evidenceCommittedDeals,
 *          attributedValue, claimedUnattested }. claimedUnattested is the
 *          board-wide solo-claim total, rounded like every other figure and
 *          ranked nowhere.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { computeLeaderboard, toPublicLeaderboard } from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  try {
    const board = toPublicLeaderboard(await computeLeaderboard());
    return NextResponse.json(board);
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
