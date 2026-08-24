/**
 * POST /api/auth/login
 *
 * Body:  { username, password }
 * Reply: { username } and sets the session cookie.
 *
 * Rate limits (lib/ratelimit.ts): 10 attempts / 5 min per handle plus
 * 30 / 5 min per IP, counted in HMAC buckets so neither is stored raw.
 * The login form shows the 429 copy verbatim.
 */

import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSession,
  normalizeUsername,
  sessionCookieOptions,
  verifyLogin,
} from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import {
  RATE_LIMITS,
  checkRateLimit,
  requestIp,
  retryPhrase,
  worstOf,
} from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const limited = worstOf(
    ...(await Promise.all([
      checkRateLimit(
        RATE_LIMITS.loginPerHandle,
        normalizeUsername(body.username ?? "") || "-",
      ),
      checkRateLimit(RATE_LIMITS.loginPerIp, requestIp(request)),
    ])),
  );
  if (limited.limited) {
    return NextResponse.json(
      {
        error: `Too many attempts. Try again in ${retryPhrase(limited.retryAfterSeconds)}.`,
        retryAfterSeconds: limited.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(limited.retryAfterSeconds) },
      },
    );
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
