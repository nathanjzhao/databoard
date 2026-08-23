/**
 * middleware.ts
 *
 * The gate. DataBoard is not publicly readable: without a session cookie,
 * only /gate, /login, /signup, /transparency, /api/auth/* and
 * /api/transparency/* (plus Next static assets) are served. Everything else,
 * the board included, redirects to /gate.
 *
 * This is deliberately only a COOKIE PRESENCE check. The edge runtime cannot
 * reach the database, so a forged cookie gets a visitor through the redirect
 * and no further: every page and API revalidates the session for real via
 * getSessionUser() (lib/auth.ts), which is the actual auth boundary. The
 * middleware exists so logged-out traffic never sees so much as the shape of
 * the board.
 */

import { NextResponse, type NextRequest } from "next/server";
import { GATE_PATH, SESSION_COOKIE, isPublicPath } from "@/lib/gate";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  if (!request.cookies.has(SESSION_COOKIE)) {
    const gate = request.nextUrl.clone();
    gate.pathname = GATE_PATH;
    gate.search = "";
    return NextResponse.redirect(gate);
  }

  return NextResponse.next();
}

export const config = {
  /*
   * Run on everything except Next internals and files with an extension
   * (favicon, svgs, fonts). API routes and pages have no dot, so they all
   * pass through. isPublicPath() re-checks the internals anyway.
   */
  matcher: ["/((?!_next/|.*\\.).*)"],
};
