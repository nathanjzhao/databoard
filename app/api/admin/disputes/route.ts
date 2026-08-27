/**
 * GET /api/admin/disputes
 *
 * Operator-only: every open (unresolved) referral dispute, newest first.
 * Handles, the derived dispute id, timestamps, and a windowExpired flag;
 * nothing an operator does not already see on /invites. No dollar figures:
 * the ruling is uphold-or-reject on the pair, not on an amount.
 *
 * Denial shape matches the other /api/admin routes: 401 signed out, 403
 * without the flag, both with the same { error: "Not found." } body, so the
 * path never confirms an admin surface to a probing user.
 *
 * Reply: { disputes: [{ disputeId, payerUsername, payeeUsername,
 *                       raisedByUsername, raisedAt, windowExpired }] }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { isOperator } from "@/lib/moderation";
import { listOpenDisputes } from "@/lib/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DENIED = { error: "Not found." };

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json(DENIED, { status: 401 });
    if (!(await isOperator(user.id))) return NextResponse.json(DENIED, { status: 403 });

    return NextResponse.json({ disputes: await listOpenDisputes() });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
