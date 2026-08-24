/**
 * POST /api/admin/asks/[id]/unhide
 *
 * Operator-only: remove a hide and restore the ask everywhere. Nothing was
 * deleted by the hide, so this is a single row delete.
 *
 * Denial shape matches /api/admin/asks/[id]/hide: 401 signed out, 403
 * without the operator flag, both with the same { error: "Not found." }
 * body, so probing the path teaches nothing.
 *
 * Reply: 200 { ok: true }; 404 when the ask is not currently hidden (or
 * does not exist, which is the same thing to an unhide).
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { isOperator, unhideAsk } from "@/lib/moderation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DENIED = { error: "Not found." };

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json(DENIED, { status: 401 });
    if (!(await isOperator(user.id))) return NextResponse.json(DENIED, { status: 403 });

    const { id } = await params;
    const result = await unhideAsk(user.id, id);
    if (!result.ok) {
      if (result.error === "not_operator") return NextResponse.json(DENIED, { status: 403 });
      return NextResponse.json({ error: "Not hidden." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
