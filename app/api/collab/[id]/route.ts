/**
 * POST /api/collab/:id
 *
 * Resolves one collaboration request.
 *
 * Body:  { action: "accept" | "decline" | "withdraw" }
 * Reply: accept   -> { status: "accepted", threadId }   (thread is live)
 *        decline  -> { status: "declined" }
 *        withdraw -> { status: "withdrawn" }
 *
 * Accept and decline belong to the owner of the targeted ask; withdraw
 * belongs to the requester. Accepting creates the thread and both
 * memberships in one transaction, and the client is expected to send people
 * to /messages/<threadId>.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { respondToCollabRequest } from "@/lib/matching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERRORS: Record<string, { message: string; status: number }> = {
  not_found: { message: "No such collaboration request.", status: 404 },
  not_yours: { message: "That request is not yours to resolve.", status: 403 },
  already_handled: { message: "That request was already resolved.", status: 409 },
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id } = await params;

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  const action = body.action;
  if (action !== "accept" && action !== "decline" && action !== "withdraw") {
    return NextResponse.json(
      { error: 'action must be "accept", "decline" or "withdraw".' },
      { status: 400 },
    );
  }

  try {
    const result = await respondToCollabRequest(user.id, id, action);
    if (!result.ok) {
      const mapped = ERRORS[result.error] ?? { message: "Request failed.", status: 400 };
      return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    }
    if (result.status === "accepted") {
      return NextResponse.json({ status: "accepted", threadId: result.threadId });
    }
    return NextResponse.json({ status: result.status });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
