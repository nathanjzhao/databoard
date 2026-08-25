/**
 * lib/db.ts
 *
 * One @libsql/client handle for the whole process, and the code that applies
 * the schema. Raw SQL only, no ORM: db/schema.sql is the contract we publish
 * on /transparency, so it has to be the actual thing we run.
 *
 * Where the database lives:
 *   * Production: TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN). Serverless-safe.
 *   * Local dev and scripts: file:data/app.db, created on first use.
 *   * Production with neither configured: getDb() throws DbNotConfiguredError
 *     and pages render a plain "database not configured" notice instead of a
 *     500. isDbConfigured() is the cheap way to check first.
 *
 * The schema itself comes from lib/schema.generated.ts (written by
 * scripts/gen-schema-module.mjs before every dev/build/seed), never from a
 * runtime fs read. It is all CREATE ... IF NOT EXISTS, applied once per
 * process on the first getDb() call.
 */

import { createClient, type Client } from "@libsql/client";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema.generated.ts";

export type DB = Client;

export class DbNotConfiguredError extends Error {
  constructor() {
    super(
      "No database configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.",
    );
    this.name = "DbNotConfiguredError";
  }
}

type DbTarget = { url: string; authToken?: string };

function resolveTarget(): DbTarget | null {
  const url = process.env.TURSO_DATABASE_URL;
  if (url && url.length > 0) {
    // A CI runner or the Playwright webServer must never talk to a remote
    // database: a leaked .env.production.local once pointed the whole test
    // suite at production. Fail loudly instead of quietly writing there.
    if (process.env.CI && !process.env.VERCEL) {
      throw new Error(
        "TURSO_DATABASE_URL is set in a CI/test environment; refusing a remote database.",
      );
    }
    return { url, authToken: process.env.TURSO_AUTH_TOKEN || undefined };
  }
  if (process.env.VERCEL && !process.env.BLIND_TENDER_DB) {
    // DEPLOYED with no database. Callers show the notice; nothing crashes.
    // Gate on VERCEL, not NODE_ENV: a locally-built `next start` (CI runs
    // the suites that way) is not a deployment and gets the file DB below.
    return null;
  }
  // Local dev / scripts: a file next to the repo. BLIND_TENDER_DB overrides
  // for tests that want a throwaway path.
  return { url: process.env.BLIND_TENDER_DB ?? localFileUrl() };
}

function localFileUrl(): string {
  const dataDir = path.join(process.cwd(), "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return "file:" + path.join(dataDir, "app.db");
}

export function isDbConfigured(): boolean {
  return resolveTarget() !== null;
}

/**
 * Next dev reloads modules constantly, and serverless containers reuse the
 * process across invocations. Stash the handle and the one-time schema apply
 * on globalThis so neither happens more than once per process.
 */
const globalForDb = globalThis as unknown as {
  __dataBoardDb?: Client;
  __dataBoardSchemaReady?: Promise<void>;
};

/**
 * The one entry point. Await it in every route/page/script that talks to the
 * database. The first call per process applies db/schema.sql idempotently.
 */
export async function getDb(): Promise<Client> {
  const target = resolveTarget();
  if (!target) throw new DbNotConfiguredError();

  if (!globalForDb.__dataBoardDb) {
    globalForDb.__dataBoardDb = createClient(target);
  }
  const client = globalForDb.__dataBoardDb;

  if (!globalForDb.__dataBoardSchemaReady) {
    globalForDb.__dataBoardSchemaReady = client
      .executeMultiple(SCHEMA_SQL)
      .catch((err) => {
        // Let the next request retry rather than caching a poisoned promise.
        globalForDb.__dataBoardSchemaReady = undefined;
        throw err;
      });
  }
  await globalForDb.__dataBoardSchemaReady;

  return client;
}

/** The bytes of db/schema.sql, rendered verbatim on /transparency. */
export function readSchemaSql(): string {
  return SCHEMA_SQL;
}

/** Close and forget the handle. Used by scripts, not by request handlers. */
export function closeDb(): void {
  globalForDb.__dataBoardDb?.close();
  globalForDb.__dataBoardDb = undefined;
  globalForDb.__dataBoardSchemaReady = undefined;
}

/* ---------------------------------------------------------------- helpers */

/** Milliseconds since epoch. Every *_at column in the schema uses this. */
export function now(): number {
  return Date.now();
}

/**
 * The list of table names actually present, so /transparency can show that
 * the running database has exactly the tables the published schema declares
 * and nothing extra.
 */
export async function listTables(): Promise<string[]> {
  const db = await getDb();
  const rs = await db.execute(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'
      ORDER BY name`,
  );
  return rs.rows.map((r) => String(r.name));
}

/**
 * Column names for a table, for the same audit-it-yourself purpose.
 * PRAGMA cannot take a bound parameter, so the name is checked against the
 * real table list before it goes anywhere near a query string.
 */
export async function listColumns(table: string): Promise<string[]> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return [];
  if (!(await listTables()).includes(table)) return [];
  const db = await getDb();
  const rs = await db.execute(`PRAGMA table_info(${table})`);
  return rs.rows.map((r) => String(r.name));
}
