/**
 * GET/POST /api/dev-boom
 *
 * Test-only detonator for the error-capture pipeline (instrumentation.ts ->
 * lib/ops.ts -> ops_errors). tests/hardening.spec.ts hits it with a query
 * string and a request body full of markers, then asserts the captured row
 * kept neither.
 *
 * In production builds this route does not throw and reveals nothing: it
 * returns the same 404 body a missing route would. The throw happens only
 * when NODE_ENV !== "production", i.e. under `next dev`.
 *
 * The thrown message deliberately embeds an email-shaped string and a long
 * digit run so the spec can prove lib/ops.ts scrubs both patterns even when
 * an exception quotes them.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function boom(): NextResponse {
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      "dev-boom: synthetic failure quoting boom-victim@example.net and +1 415 555 0199",
    );
  }
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function GET() {
  return boom();
}

export async function POST() {
  return boom();
}
