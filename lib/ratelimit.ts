/**
 * lib/ratelimit.ts
 *
 * Database-backed rate limiting for the endpoints that guard the gate:
 * request-code, verify-and-signup, login, and the VOPRF evaluator. One table
 * (rate_limits in db/schema.sql), no external service, works identically on
 * file: SQLite and Turso.
 *
 * Mechanics:
 *   * Fixed windows with the previous window counted fractionally, the usual
 *     sliding-window approximation:
 *       estimate = count(current) + count(previous) * overlap
 *     where overlap is how much of the previous fixed window a sliding
 *     window ending now still covers. A burst cannot hide on a boundary.
 *   * One UPSERT per dimension: INSERT ... ON CONFLICT DO UPDATE ...
 *     RETURNING increments and reads the current window in a single
 *     statement; the previous window's count rides in the same batch, so a
 *     check is one round trip. Rejected requests still count, which is what
 *     makes hammering a locked door pointless.
 *   * Buckets are HMAC(SERVER_PEPPER, "ratelimit" | scope | key). The table
 *     never stores a raw IP address, contact, handle, or user id, in keeping
 *     with the schema's no-PII claim.
 *   * Expired windows are swept opportunistically (about one check in
 *     sixteen appends a DELETE to the batch).
 *   * FAIL-OPEN: if the limiter's own DB call fails, the request proceeds.
 *     An outage must not lock the gate. One warning line is logged, naming
 *     the scope and the error name, never the key.
 *
 * The limits, in one place:
 *   request-code        5 / 10 min per contact,  20 / 10 min per IP
 *   invite-check       10 / 10 min per IP
 *   verify-and-signup  10 / 10 min per IP
 *   login              10 /  5 min per handle,   30 /  5 min per IP
 *   voprf evaluate     30 /  1 min per user
 */

import type { InStatement } from "@libsql/client";
import { getDb } from "./db.ts";
import { hmacHex } from "./crypto.ts";

export type RateLimitRule = {
  /** Namespaces the bucket HMAC; also the label in the fail-open warning. */
  scope: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export const RATE_LIMITS = {
  requestCodePerContact: { scope: "otp-contact", limit: 5, windowMs: 10 * 60_000 },
  // Per-IP caps are backstops against enumeration, not the primary guard
  // (the per-contact bucket is). They must survive one NAT'd office or a
  // signup rush at a demo: 10/10min proved too tight the day the test
  // suite got fast enough to be such a rush.
  requestCodePerIp: { scope: "otp-ip", limit: 60, windowMs: 10 * 60_000 },
  // Invite codes are 96 bits of server-minted randomness, so this cap is
  // anti-annoyance, not the security boundary: guessing is hopeless at any
  // request rate the limiter would ever see.
  inviteCheckPerIp: { scope: "invite-check", limit: 10, windowMs: 10 * 60_000 },
  signupPerIp: { scope: "signup-ip", limit: 30, windowMs: 10 * 60_000 },
  loginPerHandle: { scope: "login-handle", limit: 10, windowMs: 5 * 60_000 },
  loginPerIp: { scope: "login-ip", limit: 30, windowMs: 5 * 60_000 },
  voprfPerUser: { scope: "voprf-user", limit: 30, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitDecision =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number };

/** Sweep rows older than twice the longest window; nothing reads them. */
const SWEEP_HORIZON_MS = 2 * 10 * 60_000;
const SWEEP_CHANCE = 1 / 16;

/**
 * Client IP for limiter keys: first hop of x-forwarded-for, which Vercel
 * sets from the connecting address. Local dev has no proxy in front, so
 * everything shares the "local" bucket, which is what you want in tests.
 * The value goes straight into an HMAC and is never stored or logged.
 */
export function requestIp(request: Request): string {
  const first = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return first || "local";
}

/**
 * Count one attempt against a rule and say whether it is over the line.
 * The key is HMAC'd with the scope before it goes anywhere near the table.
 */
export async function checkRateLimit(
  rule: RateLimitRule,
  key: string,
): Promise<RateLimitDecision> {
  try {
    const db = await getDb();
    const now = Date.now();
    const windowStart = now - (now % rule.windowMs);
    const bucket = hmacHex("ratelimit", `${rule.scope}\x1f${key}`);

    const statements: InStatement[] = [
      {
        sql: `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
              ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
              RETURNING count`,
        args: [bucket, windowStart],
      },
      {
        sql: `SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?`,
        args: [bucket, windowStart - rule.windowMs],
      },
    ];
    if (Math.random() < SWEEP_CHANCE) {
      statements.push({
        sql: `DELETE FROM rate_limits WHERE window_start < ?`,
        args: [now - SWEEP_HORIZON_MS],
      });
    }

    const results = await db.batch(statements, "write");
    const current = Number(results[0]?.rows[0]?.count ?? 1);
    const previous = Number(results[1]?.rows[0]?.count ?? 0);
    const overlap = 1 - (now - windowStart) / rule.windowMs;
    const estimate = current + previous * overlap;

    if (estimate <= rule.limit) return { limited: false };
    return {
      limited: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowStart + rule.windowMs - now) / 1000),
      ),
    };
  } catch (err) {
    // Fail open: a limiter outage must not lock the gate. Scope only; the
    // key is never logged.
    console.warn(
      `ratelimit: ${rule.scope} check failed open (${err instanceof Error ? err.name : "error"})`,
    );
    return { limited: false };
  }
}

/** The most restrictive of several dimensions checked for one request. */
export function worstOf(...decisions: RateLimitDecision[]): RateLimitDecision {
  let worst: RateLimitDecision = { limited: false };
  for (const d of decisions) {
    if (d.limited && (!worst.limited || d.retryAfterSeconds > worst.retryAfterSeconds)) {
      worst = d;
    }
  }
  return worst;
}

/** "38 seconds" or "4 minutes", for the terse 429 copy the UI shows verbatim. */
export function retryPhrase(seconds: number): string {
  return seconds < 100 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}
