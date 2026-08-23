/**
 * scripts/gen-schema-module.mjs
 *
 * Prebuild step: copy db/schema.sql into lib/schema.generated.ts as an
 * exported string. Serverless bundles cannot rely on reading arbitrary files
 * off disk at runtime, so both the schema apply in lib/db.ts and the verbatim
 * render on /transparency import this module instead of touching the
 * filesystem. Runs before dev, build and seed (see package.json).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "db", "schema.sql");
const outPath = path.join(root, "lib", "schema.generated.ts");

const sql = readFileSync(schemaPath, "utf8");

const banner = [
  "// GENERATED FILE. Do not edit.",
  "// Source: db/schema.sql. Regenerate with: npm run gen:schema",
  "// (runs automatically before dev, build and seed)",
  "",
].join("\n");

const body = `export const SCHEMA_SQL: string = ${JSON.stringify(sql)};\n`;

writeFileSync(outPath, banner + body);
console.log(
  `gen-schema-module: wrote lib/schema.generated.ts (${sql.length} bytes of schema)`,
);
