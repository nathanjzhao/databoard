/**
 * POST /api/collab
 *
 * "I have some of that." Files a collaboration request against someone
 * else's ask.
 *
 * Body:  { askId, note? }
 * Reply: { requestId }
 *
 * One row per requester per ask (schema UNIQUE constraint). A withdrawn
 * request is revived by requesting again; a declined one stays declined.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { createCollabRequest, MAX_COLLAB_NOTE_LENGTH } from "@/lib/matching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERRORS: Record<string, { message: string; status: number }> = {
  not_found: { message: "That ask does not exist.", status: 404 },
  own_ask: { message: "That ask is yours. No need to request yourself.", status: 400 },
  ask_closed: { message: "That ask is closed.", status: 409 },
  already_requested: { message: "You already have a pending request on that ask.", status: 409 },
  already_accepted: { message: "Already accepted. The thread is in your messages.", status: 409 },
  previously_declined: { message: "The poster already declined a request from you on that ask.", status: 409 },
  note_too_long: { message: `Notes cap at ${MAX_COLLAB_NOTE_LENGTH} characters.`, status: 400 },
};

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { askId?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  const askId = typeof body.askId === "string" ? body.askId : "";
  if (!askId) return NextResponse.json({ error: "askId is required." }, { status: 400 });
  const note = typeof body.note === "string" ? body.note : "";

  try {
    const result = await createCollabRequest(user.id, askId, note);
    if (!result.ok) {
      const mapped = ERRORS[result.error] ?? { message: "Request failed.", status: 400 };
      return NextResponse.json(
        { error: mapped.message, code: result.error },
        { status: mapped.status },
      );
    }
    return NextResponse.json({ requestId: result.requestId }, { status: 201 });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
