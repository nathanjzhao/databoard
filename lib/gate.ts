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
  // The receipt verifier is public on purpose: a portable receipt is worth
  // nothing if a counterparty needs an account to check it. Verification is a
  // pure HMAC recompute (lib/receipts.ts), no session, no database.
  "/receipts/verify",
  "/api/receipts/verify",
  // NOTE: /api/signing/pubkey is deliberately NOT public. It used to be, so a
  // receipt verifier with no account could confirm a party key against the
  // board's directory. But the pubkey it returns is a deterministic function of
  // (password, handle), which made the public directory an OFFLINE
  // password-cracking oracle (F-01): anyone could fetch a handle's key and
  // brute-force the password with no session. The directory now requires a
  // session (the route enforces getSessionUser). Public /receipts/verify still
  // works: a receipt VERIFIES against the signer pubkeys it already carries in
  // its own attestation roster; the directory cross-check is an extra step
  // available only to a logged-in checker.
]);

/**
 * Prefixes reachable without a session cookie. /transparency/ covers the
 * transparency subpages (e.g. /transparency/verification), which are public
 * for the same reason /transparency is: the claims are the pitch.
 * /api/cron/ carries no session by construction (Vercel cron sends a bearer
 * token, not a cookie); each cron route enforces CRON_SECRET itself.
 */
const PUBLIC_PREFIXES = [
  "/api/auth/",
  "/api/transparency/",
  // The transparency log and its proof endpoints are public for the same
  // reason /transparency is: a tamper-evident ledger is worth nothing if you
  // need an account to read the heads and check the proofs. /transparency/log
  // is covered by the "/transparency/" prefix below; the API lives here.
  "/api/translog/",
  "/transparency/",
  "/api/cron/",
];

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
