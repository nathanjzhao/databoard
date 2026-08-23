/**
 * GET /api/deals/badge
 *
 * The nav badge for /deals, cheap enough to poll: how many deal rows are
 * sitting pending on the viewer's account, i.e. splits waiting for their
 * confirm-or-decline.
 *
 * Reply: { pendingConfirmations, badge }   (badge equals pendingConfirmations)
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { countPendingConfirmations } from "@/lib/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  try {
    const pendingConfirmations = await countPendingConfirmations(user.id);
    return NextResponse.json({ pendingConfirmations, badge: pendingConfirmations });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
