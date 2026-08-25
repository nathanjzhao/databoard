/**
 * GET /api/cron/autoclose
 *
 * The stale-ask sweep (lib/autoclose.ts): one pass that closes every open or
 * partial ask whose last affirmation is more than 7 days old, recording each
 * closure in ask_closures as 'auto_stale'.
 *
 * Reply: { closed: n }
 *
 * Auth: `authorization: Bearer <CRON_SECRET>`, which is exactly what Vercel
 * cron sends when CRON_SECRET is set on the project (vercel.json schedules
 * this path daily). Outside production the check is waived so local runs and
 * the test suites can trigger a pass with a bare GET; the same pass is also
 * runnable without a server via `npm run autoclose`.
 *
 * A production deployment with no CRON_SECRET answers 503 rather than
 * running an unauthenticated close over live data.
 */

import { NextResponse } from "next/server";
import { DbNotConfiguredError } from "@/lib/db";
import { runAutoclose } from "@/lib/autoclose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    const secret = process.env.CRON_SECRET ?? "";
    if (!secret) {
      return NextResponse.json(
        { error: "CRON_SECRET is not configured." },
        { status: 503 },
      );
    }
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Not the cron." }, { status: 401 });
    }
  }

  try {
    const { closed } = await runAutoclose();
    return NextResponse.json({ closed });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
