/**
 * GET /api/admin/signals?limit=20
 *
 * Operator-only: the three graph-analytics signatures (fee-sink, sock,
 * remainder outlier), each a ranked list of contributing counts. Risk signals
 * for review, never automated penalties; the /admin panel says so and so does
 * lib/graph-signals.ts. No amounts beyond nearest-$10k buckets, no buyer
 * de-blinding, no PII beyond the usernames the board already shows.
 *
 * Denial shape matches the other /api/admin routes: 401 signed out, 403
 * without the flag, both with the same { error: "Not found." } body, so the
 * path never confirms an admin surface to a probing user. limit is clamped
 * to 1..100 in the lib, default 20.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { isOperator } from "@/lib/moderation";
import { computeGraphSignals, DEFAULT_SIGNAL_LIMIT } from "@/lib/graph-signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DENIED = { error: "Not found." };

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json(DENIED, { status: 401 });
    if (!(await isOperator(user.id))) return NextResponse.json(DENIED, { status: 403 });

    const limitParam = new URL(request.url).searchParams.get("limit");
    const limit = limitParam == null ? DEFAULT_SIGNAL_LIMIT : Number(limitParam);
    return NextResponse.json({ signals: await computeGraphSignals(limit) });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
