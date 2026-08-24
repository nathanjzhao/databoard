/**
 * lib/ops.ts
 *
 * Error capture. instrumentation.ts calls captureError once per server
 * error; /api/admin/errors reads the result back for operators. This module
 * is the single write path into ops_errors, so the privacy rules live here
 * where they can be read in one place:
 *
 *   * route is a PATHNAME. Query string and fragment are stripped before
 *     anything else happens, so a token or a search term in a URL never
 *     lands in the table.
 *   * Request bodies, headers and cookies are never accepted by this API.
 *     There is no parameter to pass them through.
 *   * message and stack are length-capped and scrubbed: email-shaped
 *     substrings and long digit runs are redacted before the write. An
 *     exception that quotes user input does not reach the table verbatim.
 *   * No user_id, no session, no IP. A row says what broke, not who hit it.
 *
 * Sampling: a digest already written in the last minute is skipped, so a
 * hot loop of the same failure costs one row per minute, not thousands.
 * Every failure in here is swallowed on purpose: error capture must never
 * become the error.
 */

import { getDb, now } from "./db.ts";
import { newId, sha256Hex } from "./crypto.ts";

const ROUTE_CAP = 200;
const KIND_CAP = 60;
const MESSAGE_CAP = 500;
const STACK_CAP = 2000;
const SAMPLE_WINDOW_MS = 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type CapturedError = {
  /** Request path. Anything after "?" or "#" is discarded here. */
  route: string;
  /** Router context, e.g. "route", "render:react-server-components". */
  kind: string;
  message: string;
  stack?: string;
  /** Next's error digest when it has one; otherwise derived from the rest. */
  digest?: string;
};

export type OpsErrorRow = {
  id: string;
  at: number;
  route: string;
  kind: string;
  message: string;
  stack: string;
  digest: string;
};

/** Pathname only: everything from the first "?" or "#" on is dropped. */
function pathOnly(route: string): string {
  return route.split(/[?#]/, 1)[0] ?? "";
}

/**
 * Redact the two shapes PII takes when an error message quotes input:
 * email addresses and long digit runs (phone numbers, with or without
 * separators). Line:column pairs in stacks survive because ":" is not a
 * separator character here.
 */
function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted]");
}

/**
 * Write one sanitized error row. Fail-silent by contract: this function
 * never throws and never logs anything beyond what it stores.
 */
export async function captureError(e: CapturedError): Promise<void> {
  try {
    const route = pathOnly(e.route).slice(0, ROUTE_CAP);
    const kind = (e.kind || "unknown").slice(0, KIND_CAP);
    const message = scrub(e.message || "").slice(0, MESSAGE_CAP);
    const stack = scrub(e.stack ?? "").slice(0, STACK_CAP);
    const digest =
      e.digest && e.digest.length > 0
        ? e.digest.slice(0, 64)
        : sha256Hex(`${kind}\x1f${route}\x1f${message}`).slice(0, 16);

    const db = await getDb();
    const at = now();

    // Sample: same digest inside the window means the row already tells the
    // story. Two racing writers can both pass this check; that costs one
    // duplicate row, not correctness.
    const recent = await db.execute({
      sql: `SELECT 1 FROM ops_errors WHERE digest = ? AND at > ? LIMIT 1`,
      args: [digest, at - SAMPLE_WINDOW_MS],
    });
    if (recent.rows.length > 0) return;

    await db.execute({
      sql: `INSERT INTO ops_errors (id, at, route, kind, message, stack, digest)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [newId("err"), at, route, kind, message, stack, digest],
    });

    // Opportunistic retention sweep, same trick as rate_limits: roughly one
    // insert in 32 pays for pruning rows older than 30 days.
    if (Math.random() < 1 / 32) {
      await db.execute({
        sql: `DELETE FROM ops_errors WHERE at < ?`,
        args: [at - RETENTION_MS],
      });
    }
  } catch {
    // Capture must never cascade. Nothing to do and nowhere safe to say it.
  }
}

/** Most recent errors, newest first. Operator-only callers. */
export async function listRecentErrors(limit: number): Promise<OpsErrorRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT id, at, route, kind, message, stack, digest
            FROM ops_errors ORDER BY at DESC LIMIT ?`,
    args: [n],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    at: Number(r.at),
    route: String(r.route),
    kind: String(r.kind),
    message: String(r.message),
    stack: String(r.stack),
    digest: String(r.digest),
  }));
}
