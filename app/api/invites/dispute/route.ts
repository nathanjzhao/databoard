/**
 * POST /api/invites/dispute
 *
 * Body:  { withUsername }
 *
 * One click marks the caller's ledger pair with that account disputed. The
 * direction (who owes whom) is derived from the invite chain, not declared.
 * A disputed pair stops counting toward "behind on referral obligations",
 * shows disputed to both parties, and is listed for operators on /invites.
 * It is an escape valve with a paper trail, not forgiveness.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { raiseDispute } from "@/lib/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { withUsername?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    const result = await raiseDispute(user.id, String(body.withUsername ?? ""));
    if (!result.ok) {
      const copy: Record<typeof result.error, string> = {
        unknown_username: "No account by that handle.",
        not_in_chain: "That account is not on your invite chain within 6 steps.",
        already_disputed: "That pair is already disputed.",
      };
      return NextResponse.json(
        { error: copy[result.error] },
        { status: result.error === "already_disputed" ? 409 : 400 },
      );
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
