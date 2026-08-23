/**
 * scripts/reset-db.mjs
 *
 * Deletes the LOCAL sqlite file (data/app.db and its WAL sidecars). The next
 * query recreates the schema from scratch. Refuses to touch a remote Turso
 * database: point-and-shoot deletion of production is not a script we ship.
 */

import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.TURSO_DATABASE_URL) {
  console.error(
    "reset-db: TURSO_DATABASE_URL is set. This script only resets the local\n" +
      "file database. For a remote reset, drop the tables from the Turso CLI\n" +
      "yourself, deliberately.",
  );
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(root, "data", "app.db");

let removed = 0;
for (const suffix of ["", "-wal", "-shm"]) {
  const file = base + suffix;
  if (existsSync(file)) {
    rmSync(file);
    removed++;
    console.log(`reset-db: removed ${path.relative(root, file)}`);
  }
}
if (removed === 0) console.log("reset-db: nothing to remove, already clean");
