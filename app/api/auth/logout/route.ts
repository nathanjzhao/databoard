/**
 * POST /api/auth/logout
 *
 * Deletes the session row and clears the cookie.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, clearedCookieOptions, destroySession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await destroySession(token);
    } catch {
      // No database, no session rows to delete. Still clear the cookie.
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", clearedCookieOptions());
  return response;
}
