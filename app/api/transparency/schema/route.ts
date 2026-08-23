/**
 * GET /api/transparency/schema
 *
 * db/schema.sql as text/plain, for anyone auditing from a terminal instead of
 * a browser. Served from the same generated module that lib/db.ts applies at
 * startup, so this is the schema that runs, not a copy that could drift.
 * Public by design (see lib/gate.ts): the privacy claims are the pitch, and
 * a claim you cannot fetch is not a claim.
 */

import { readSchemaSql } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(readSchemaSql(), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
