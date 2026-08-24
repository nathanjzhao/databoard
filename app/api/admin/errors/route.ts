/**
 * GET /api/admin/errors?limit=50
 *
 * Recent captured server errors (ops_errors), newest first. Operator-only:
 * anyone else gets the same 404 a wrong URL gets, so the endpoint does not
 * advertise itself. limit is clamped to 1..200, default 50.
 *
 * Rows are already sanitized at the write site (lib/ops.ts): pathname-only
 * routes, scrubbed capped text, no user attribution. This route adds
 * nothing and filters nothing.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { isOperator } from "@/lib/moderation";
import { listRecentErrors } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user || !(await isOperator(user.id))) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const limitParam = new URL(request.url).searchParams.get("limit");
    const errors = await listRecentErrors(Number(limitParam ?? "50"));
    return NextResponse.json({ errors });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: "No database configured." }, { status: 503 });
    }
    throw err;
  }
}
