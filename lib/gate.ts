/**
 * lib/gate.ts
 *
 * The access-gating contract, shared between middleware.ts (edge runtime, so
 * it cannot import anything that touches the database) and the node-side auth
 * code. Pure constants and pure functions only. Nothing here may import
 * lib/db.ts or any module that does.
 */

export const SESSION_COOKIE = "bt_session";

/** Where a logged-out visitor lands, whatever they asked for. */
export const GATE_PATH = "/gate";

/**
 * Exact paths reachable without a session cookie. The VOPRF public key is
 * public on purpose: it is the verification anchor for blinded buyer
 * tokens, and anyone must be able to check that the key printed on
 * /transparency is the key the server actually answers with. Evaluation
 * itself (/api/voprf/evaluate) stays behind a session.
 */
const PUBLIC_PATHS = new Set([
  "/gate",
  "/login",
  "/signup",
  "/transparency",
  "/api/voprf/pubkey",
]);

/**
 * Prefixes reachable without a session cookie. /transparency/ covers the
 * transparency subpages (e.g. /transparency/verification), which are public
 * for the same reason /transparency is: the claims are the pitch.
 */
const PUBLIC_PREFIXES = ["/api/auth/", "/api/transparency/", "/transparency/"];

/**
 * True when `pathname` may be served without a session. Next static assets
 * are excluded by the middleware matcher before this is ever consulted, but
 * the checks are cheap so we keep them here too rather than trusting the
 * matcher regex alone.
 */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") return true;
  return false;
}
