/**
 * GET /api/admin/hidden
 *
 * Operator-only: every currently hidden ask, newest hide first. Handles,
 * titles, reasons and timestamps; nothing an operator does not already see
 * on the board.
 *
 * Denial shape matches the other /api/admin routes: 401 signed out, 403
 * without the flag, both with the same { error: "Not found." } body.
 *
 * Reply: { hidden: [{ askId, title, posterUsername, reason, hiddenAt,
 *                     hiddenByUsername }] }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { isOperator, listHidden } from "@/lib/moderation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DENIED = { error: "Not found." };

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json(DENIED, { status: 401 });
    if (!(await isOperator(user.id))) return NextResponse.json(DENIED, { status: 403 });

    return NextResponse.json({ hidden: await listHidden() });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
