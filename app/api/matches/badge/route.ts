/**
 * GET /api/matches/badge
 *
 * The nav badge for /matches, cheap enough to poll.
 *
 * Reply: {
 *   pendingRequests   pending collab requests on the viewer's asks; things
 *                     waiting on a decision, which is what a badge should
 *                     count
 *   matchedAsks       live asks by others sharing a buyer token with the
 *                     viewer's asks; ambient, not actionable, so it is
 *                     reported but not folded into `badge`
 *   badge             what the nav should render; equals pendingRequests
 * }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { countIncomingCollabRequests, countMatchedAsks } from "@/lib/matching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  try {
    const [pendingRequests, matchedAsks] = await Promise.all([
      countIncomingCollabRequests(user.id),
      countMatchedAsks(user.id),
    ]);
    return NextResponse.json({
      pendingRequests,
      matchedAsks,
      badge: pendingRequests,
    });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
