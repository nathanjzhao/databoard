/**
 * GET /api/exchange/[id]
 *
 * The full session for one of its two participants: the current state, the
 * commitments, and the entire signed, hash-linked event chain (so the client
 * can re-verify every signature and link itself with lib/exchange.ts
 * verifyChain). A session the caller is not on answers 404, indistinguishable
 * from one that does not exist.
 *
 * Reply: { session: SessionView }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { getSessionView } from "../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  try {
    const session = await getSessionView(id, user.id);
    if (!session) return NextResponse.json({ error: "No such session." }, { status: 404 });
    return NextResponse.json({ session });
  } catch (e) {
    if (e instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }
}
