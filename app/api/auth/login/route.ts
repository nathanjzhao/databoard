/**
 * POST /api/auth/login
 *
 * Body:  { username, password }
 * Reply: { username } and sets the session cookie.
 */

import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSession,
  sessionCookieOptions,
  verifyLogin,
} from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    const user = await verifyLogin(body.username ?? "", body.password ?? "");
    if (!user) {
      // Deliberately does not say which half was wrong.
      return NextResponse.json(
        { error: "No match for that username and password." },
        { status: 401 },
      );
    }

    const session = await createSession(user.id);
    const response = NextResponse.json({ username: user.username });
    response.cookies.set(
      SESSION_COOKIE,
      session.token,
      sessionCookieOptions(session.expiresAt),
    );
    return response;
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
