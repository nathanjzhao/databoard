/**
 * POST /api/admin/disputes/[id]/resolve   { ruling: "uphold" | "reject" }
 *
 * Operator-only: rule on a raised referral dispute. [id] is the derived
 * dispute id (payer.payee). 'uphold' sides with the disputer and the pair's
 * gate stays lifted; 'reject' lets the debt stand and the gate returns. First
 * ruling wins; a second is refused rather than overwriting it.
 *
 * Denial shape matches the other /api/admin routes: 401 signed out, 403
 * without the flag, both with the same { error: "Not found." } body.
 *
 * Reply: 200 { ok: true, status } on success; 404 for an unknown dispute; 409
 * when it was already resolved; 400 for a ruling that is neither verb.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { isOperator } from "@/lib/moderation";
import { resolveDispute } from "@/lib/referrals";

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

    let ruling = "";
    try {
      const body = (await request.json()) as { ruling?: unknown };
      ruling = typeof body.ruling === "string" ? body.ruling : "";
    } catch {
      return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
    }

    const result = await resolveDispute(user.id, id, ruling);
    if (!result.ok) {
      switch (result.error) {
        case "not_operator":
          // The flag was revoked between the check above and the write.
          return NextResponse.json(DENIED, { status: 403 });
        case "not_found":
          return NextResponse.json({ error: "No such dispute." }, { status: 404 });
        case "bad_ruling":
          return NextResponse.json(
            { error: "Ruling must be uphold or reject." },
            { status: 400 },
          );
        case "already_resolved":
          return NextResponse.json({ error: "Already resolved." }, { status: 409 });
      }
    }
    return NextResponse.json({ ok: true, status: result.status });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
