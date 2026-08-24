/**
 * scripts/grant-operator.ts <handle>
 *
 * Grants the operator flag to an existing account, by handle. This is the
 * ONLY way the flag is granted: there is no web endpoint that writes to the
 * operators table, so becoming an operator requires the same credentials as
 * reading the database raw.
 *
 * Idempotent: granting twice reports the existing grant and changes nothing
 * (the original granted_at stands).
 *
 * Local:  npm run grant-operator -- <handle>
 * Prod:   npm run gen:schema
 *         TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
 *           node scripts/grant-operator.ts <handle>
 */

import { closeDb, getDb, now } from "../lib/db.ts";
import { findUserByUsername, normalizeUsername } from "../lib/auth.ts";

async function main() {
  const handle = normalizeUsername(process.argv[2] ?? "");
  if (!handle) {
    console.error("usage: node scripts/grant-operator.ts <handle>");
    process.exit(1);
  }

  const user = await findUserByUsername(handle);
  if (!user) {
    console.error(`no account with handle @${handle}`);
    process.exit(1);
  }

  const db = await getDb();
  const rs = await db.execute({
    sql: `INSERT INTO operators (user_id, granted_at)
          VALUES (?, ?)
          ON CONFLICT(user_id) DO NOTHING`,
    args: [user.id, now()],
  });

  if (rs.rowsAffected === 0) {
    console.log(`@${handle} was already an operator. Nothing changed.`);
  } else {
    console.log(`@${handle} is now an operator.`);
  }
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
