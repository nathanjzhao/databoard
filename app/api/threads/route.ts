/**
 * GET /api/threads
 *
 * The signed-in user's thread list, newest activity first. This is what the
 * /messages page polls. There is no POST here: threads are only created by
 * accepting a collaboration request.
 *
 * Reply: { threads: ThreadSummary[] }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { listThreadsFor } from "./store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const threads = await listThreadsFor(user.id);
    return NextResponse.json({ threads });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
