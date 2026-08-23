/**
 * scripts/apply-remote.ts
 *
 * Apply db/schema.sql (via lib/schema.generated.ts) to a remote Turso
 * database. The schema is all CREATE ... IF NOT EXISTS, so running this
 * twice is a no-op.
 *
 * Run locally against production:
 *   npm run gen:schema
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/apply-remote.ts
 */

import { createClient } from "@libsql/client";
import { SCHEMA_SQL } from "../lib/schema.generated.ts";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    console.error(
      "Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before running this.",
    );
    process.exit(1);
  }

  const db = createClient({ url, authToken });
  await db.executeMultiple(SCHEMA_SQL);

  const rs = await db.execute(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'
      ORDER BY name`,
  );
  console.log(`schema applied to ${url}`);
  console.log("tables:", rs.rows.map((r) => String(r.name)).join(", "));
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
