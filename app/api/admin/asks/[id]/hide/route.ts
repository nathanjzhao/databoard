/**
 * POST /api/admin/asks/[id]/hide   { reason: string }
 *
 * Operator-only: hide an ask from the board, matching and other members'
 * ask pages. The poster keeps their own page, with the reason on it.
 *
 * Denial shape, deliberately uniform across every /api/admin route: signed
 * out is 401 and signed-in-but-not-operator is 403, but BOTH carry the same
 * body a missing route would, { error: "Not found." }. The status code is
 * for the operator's own client; the body never confirms to a probing user
 * that an admin surface exists behind the path.
 *
 * Reply: 200 { ok: true } on success; 404 for a missing ask; 409 when the
 * ask is already hidden (the first operator's reason stands); 400 for a
 * missing or oversized reason.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { hideAsk, isOperator, MAX_HIDE_REASON_LENGTH } from "@/lib/moderation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DENIED = { error: "Not found." };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json(DENIED, { status: 401 });
    if (!(await isOperator(user.id))) return NextResponse.json(DENIED, { status: 403 });

    const { id } = await params;

    let reason = "";
    try {
      const body = (await request.json()) as { reason?: unknown };
      reason = typeof body.reason === "string" ? body.reason : "";
    } catch {
      return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
    }

    const result = await hideAsk(user.id, id, reason);
    if (!result.ok) {
      switch (result.error) {
        case "not_operator":
          // The flag was revoked between the check above and the write.
          return NextResponse.json(DENIED, { status: 403 });
        case "not_found":
          return NextResponse.json({ error: "No such ask." }, { status: 404 });
        case "already_hidden":
          return NextResponse.json({ error: "Already hidden." }, { status: 409 });
        case "bad_reason":
          return NextResponse.json(
            {
              error: `A reason is required, ${MAX_HIDE_REASON_LENGTH} characters max. The poster reads it.`,
            },
            { status: 400 },
          );
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
