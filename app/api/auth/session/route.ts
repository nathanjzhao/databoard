/**
 * GET /api/auth/session
 *
 * Reply: { user: { id, username, accountType, createdAt } | null }
 * Client components use this to find out who they are without a round trip
 * through a server component.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, getUserBySessionToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  try {
    return NextResponse.json({ user: await getUserBySessionToken(token) });
  } catch {
    return NextResponse.json({ user: null });
  }
}
