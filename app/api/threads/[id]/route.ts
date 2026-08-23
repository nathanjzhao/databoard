/**
 * GET /api/threads/:id[?since=<ms>]
 *
 * One thread with its messages, for the thread view and its poller. `since`
 * is the client's high-water mark: only messages with created_at >= since
 * come back (the client dedupes by id), so polling stays cheap.
 *
 * A thread the caller is not in answers 404, indistinguishable from a thread
 * that does not exist. Fetching marks the thread read for the caller.
 *
 * Reply: { thread: ThreadDetail }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { loadThread } from "../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const { id } = await context.params;
    const sinceRaw = Number(new URL(request.url).searchParams.get("since") ?? "0");
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

    const thread = await loadThread(id, user.id, since);
    if (!thread) {
      return NextResponse.json({ error: "No such thread." }, { status: 404 });
    }
    return NextResponse.json({ thread });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
