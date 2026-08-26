/**
 * tests/invite-codes.ts
 *
 * Signup is invite-only, so every spec that walks the signup flow needs a
 * spendable code. The seed mints a pool of unused codes through the real
 * mint path; this helper reads one straight from the local database file,
 * the same file the specs already open for their privacy scans.
 *
 * A code is only SPENT by verify-and-signup, so request-code-only tests can
 * reuse the code they fetched, and sequential full signups naturally pick a
 * fresh one: by the time the next signup asks, the previous one's code has
 * used_by set. The suites run on one worker, so two signups never race for
 * the same row.
 */

import { createClient } from "@libsql/client";
import path from "node:path";

const DB_PATH = path.join(__dirname, "..", "data", "app.db");

/** One still-unused invite code from the seeded pool, deterministic order. */
export async function unusedInviteCode(): Promise<string> {
  const client = createClient({ url: `file:${DB_PATH}` });
  try {
    const rs = await client.execute(
      `SELECT code FROM invites WHERE used_by IS NULL ORDER BY created_at, code LIMIT 1`,
    );
    if (rs.rows.length === 0) {
      throw new Error(
        "no unused invite codes in data/app.db; run `npm run reset-db && npm run seed`",
      );
    }
    return String(rs.rows[0].code);
  } finally {
    client.close();
  }
}
