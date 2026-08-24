/**
 * scripts/backup.ts
 *
 * Dump every table of the target database to a gzipped JSON file:
 *
 *   backups/databoard-<utc timestamp>.json.gz
 *   { schema_version: sha256 of db/schema.sql, exported_at, tables: {name: rows[]} }
 *
 * Target selection:
 *   node scripts/backup.ts           local file DB (BLIND_TENDER_DB or file:data/app.db)
 *   node scripts/backup.ts --prod    TURSO_DATABASE_URL + TURSO_AUTH_TOKEN from env
 *   ... --out <path>                 override the output path
 *
 * The default is ALWAYS the local file, even when Turso env vars happen to
 * be set in the shell: touching production is spelled --prod, nothing else.
 *
 * The dump contains password hashes, blind indexes, session hashes and all
 * pseudonymous content. It must live somewhere private. Never commit it,
 * never put it in CI artifacts of a public repo. backups/ is gitignored.
 *
 * scripts/restore.ts replays a dump into an EMPTY database.
 */

import { createClient, type Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  // scripts/ lives one level below the repo root.
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

function schemaSha(): string {
  const sql = readFileSync(path.join(repoRoot(), "db", "schema.sql"));
  return createHash("sha256").update(sql).digest("hex");
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
  if (url.startsWith("file:") && !existsSync(url.slice("file:".length))) {
    fail(`No database at ${url}. Nothing to back up.`);
  }
  return { db: createClient({ url, intMode: "number" }), label: url };
}

async function listUserTables(db: Client): Promise<string[]> {
  const rs = await db.execute(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'
      ORDER BY name`,
  );
  return rs.rows.map((r) => String(r.name)).filter((n) => IDENT_RE.test(n));
}

/** TEXT/INTEGER schema, but encode blobs anyway so a dump never lies. */
function encodeValue(v: unknown): unknown {
  if (v instanceof ArrayBuffer) {
    return { $blob: Buffer.from(v).toString("base64") };
  }
  if (v instanceof Uint8Array) {
    return { $blob: Buffer.from(v).toString("base64") };
  }
  if (typeof v === "bigint") return Number(v);
  return v;
}

async function dumpTable(
  db: Client,
  table: string,
): Promise<Record<string, unknown>[]> {
  // table came from sqlite_master and matched IDENT_RE; safe to interpolate.
  const rs = await db.execute(`SELECT * FROM "${table}"`);
  return rs.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const col of rs.columns) obj[col] = encodeValue(row[col]);
    return obj;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const prod = args.includes("--prod");
  const outFlag = args.indexOf("--out");
  const outPath =
    outFlag >= 0 && args[outFlag + 1]
      ? path.resolve(args[outFlag + 1])
      : path.join(
          repoRoot(),
          "backups",
          `databoard-${new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}.json.gz`,
        );

  const { db, label } = resolveClient(prod);
  const tables = await listUserTables(db);
  if (tables.length === 0) fail(`No tables in ${label}. Nothing to back up.`);

  const dump: Dump = {
    schema_version: schemaSha(),
    exported_at: new Date().toISOString(),
    tables: {},
  };
  for (const table of tables) {
    dump.tables[table] = await dumpTable(db, table);
  }
  db.close();

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, gzipSync(JSON.stringify(dump)));

  console.log(`source  ${label}`);
  console.log(`wrote   ${outPath}`);
  console.log(`schema  ${dump.schema_version}`);
  for (const table of tables) {
    console.log(`  ${table}: ${dump.tables[table].length} rows`);
  }
  console.log(
    "This file holds password hashes and pseudonymous content. Keep it private.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
