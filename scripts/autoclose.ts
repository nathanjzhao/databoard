/**
 * scripts/autoclose.ts
 *
 * The same stale-ask sweep the Vercel cron triggers through
 * GET /api/cron/autoclose, runnable without a server:
 *
 *   npm run autoclose
 *
 * Targets whatever database the environment points at (local file by
 * default, Turso with TURSO_DATABASE_URL set), exactly like every other
 * script here. Used by local ops and the test suites; prints what it closed.
 */

import { closeDb } from "../lib/db.ts";
import { runAutoclose } from "../lib/autoclose.ts";

async function main() {
  if (process.env.TURSO_DATABASE_URL) {
    console.log("autoclose: targeting remote database at TURSO_DATABASE_URL");
  }
  const { closed, askIds } = await runAutoclose();
  console.log(`autoclose: closed ${closed} stale ask${closed === 1 ? "" : "s"}`);
  for (const id of askIds) console.log(`  ${id}`);
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
