/**
 * scripts/restore.ts
 *
 * Replay a scripts/backup.ts dump into an EMPTY database. A target with any
 * rows in any user table is refused outright: restore is for a fresh
 * database after a loss, not for merging, and a merge would silently
 * violate UNIQUE constraints or double data.
 *
 *   node scripts/restore.ts backups/databoard-<ts>.json.gz          local target
 *   node scripts/restore.ts backups/databoard-<ts>.json.gz --prod   Turso target
 *
 * Local target is BLIND_TENDER_DB or file:data/app.db; --prod reads
 * TURSO_DATABASE_URL + TURSO_AUTH_TOKEN from the env. The current
 * db/schema.sql is applied first (CREATE ... IF NOT EXISTS), then rows are
 * inserted parents-before-children so foreign keys and the deal-shares
 * trigger see a consistent order. A dump made under an older schema
 * restores cleanly into a newer one because the schema only ever grows; a
 * dump naming a table the schema no longer has aborts before any write.
 */

import { createClient, type Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parents before children. Tables not listed here restore last, sorted. */
const KNOWN_ORDER = [
  "users",
  "user_e2ee_keys",
  "sessions",
  "rate_limits",
  "operators",
  "asks",
  "ask_mandates",
  "hidden_asks",
  "collab_requests",
  "threads",
  "thread_participants",
  "thread_keys",
  "messages",
  "deals",
  "deal_participants",
  "ops_errors",
];

type Dump = {
  schema_version: string;
  exported_at: string;
  tables: Record<string, Record<string, unknown>[]>;
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

function resolveClient(prod: boolean): { db: Client; label: string } {
  if (prod) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      fail("--prod needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the env.");
    }
    return { db: createClient({ url, authToken, intMode: "number" }), label: url };
  }
  const url =
    process.env.BLIND_TENDER_DB ??
    "file:" + path.join(repoRoot(), "data", "app.db");
  return { db: createClient({ url, intMode: "number" }), label: url };
}

function readDump(file: string): Dump {
  const raw = readFileSync(file);
  // gzip magic bytes; also accept a plain .json for hand-inspected dumps.
  const text =
    raw[0] === 0x1f && raw[1] === 0x8b
      ? gunzipSync(raw).toString("utf8")
      : raw.toString("utf8");
  const dump = JSON.parse(text) as Dump;
  if (
    typeof dump !== "object" ||
    dump === null ||
    typeof dump.schema_version !== "string" ||
    typeof dump.tables !== "object" ||
    dump.tables === null
  ) {
    fail(`${file} is not a scripts/backup.ts dump.`);
  }
  return dump;
}

async function listUserTables(db: Client): Promise<string[]> {
  const rs = await db.execute(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'
      ORDER BY name`,
  );
  return rs.rows.map((r) => String(r.name)).filter((n) => IDENT_RE.test(n));
}

/** Empty means: no user table has any rows. No tables at all is empty too. */
async function assertEmpty(db: Client, label: string): Promise<void> {
  for (const table of await listUserTables(db)) {
    const rs = await db.execute(`SELECT 1 FROM "${table}" LIMIT 1`);
    if (rs.rows.length > 0) {
      fail(
        `Refusing to restore: ${label} is not empty (${table} has rows). ` +
          `Restore only targets an empty database.`,
      );
    }
  }
}

function decodeValue(v: unknown): unknown {
  if (
    typeof v === "object" &&
    v !== null &&
    "$blob" in v &&
    typeof (v as { $blob: unknown }).$blob === "string"
  ) {
    return Buffer.from((v as { $blob: string }).$blob, "base64");
  }
  return v;
}

function orderTables(names: string[]): string[] {
  const known = KNOWN_ORDER.filter((t) => names.includes(t));
  const rest = names.filter((t) => !KNOWN_ORDER.includes(t)).sort();
  return [...known, ...rest];
}

async function insertRows(
  db: Client,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  for (const col of cols) {
    if (!IDENT_RE.test(col)) fail(`Bad column name in dump: ${table}.${col}`);
  }
  const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
               VALUES (${cols.map(() => "?").join(", ")})`;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.batch(
      rows.slice(i, i + CHUNK).map((row) => ({
        sql,
        args: cols.map((c) => decodeValue(row[c]) as never),
      })),
      "write",
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const prod = args.includes("--prod");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) fail("Usage: node scripts/restore.ts <dump.json.gz> [--prod]");

  const dump = readDump(path.resolve(file));
  const { db, label } = resolveClient(prod);

  await assertEmpty(db, label);

  // Apply the current schema so the tables exist. IF NOT EXISTS end to end.
  const schemaSql = readFileSync(path.join(repoRoot(), "db", "schema.sql"), "utf8");
  const currentSha = createHash("sha256").update(schemaSql).digest("hex");
  if (dump.schema_version !== currentSha) {
    console.warn(
      `note: dump schema ${dump.schema_version.slice(0, 12)} != current ` +
        `${currentSha.slice(0, 12)}. The schema is additive, so an older dump ` +
        `restores into a newer schema; check table names if anything fails.`,
    );
  }
  await db.executeMultiple(schemaSql);

  const targetTables = await listUserTables(db);
  const dumpTables = Object.keys(dump.tables).filter((t) => IDENT_RE.test(t));
  const missing = dumpTables.filter((t) => !targetTables.includes(t));
  if (missing.length > 0) {
    fail(
      `Refusing to restore: dump has tables the schema does not: ` +
        `${missing.join(", ")}. Nothing was written.`,
    );
  }

  for (const table of orderTables(dumpTables)) {
    await insertRows(db, table, dump.tables[table]);
    console.log(`  ${table}: ${dump.tables[table].length} rows`);
  }
  db.close();

  console.log(`restored ${dump.exported_at} dump into ${label}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
