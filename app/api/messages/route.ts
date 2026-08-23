/**
 * POST /api/messages
 *
 * Appends one plain-text message to a thread the sender participates in.
 * Sending to a thread you are not in gets the same 404 as a thread that
 * does not exist.
 *
 * Body:  { threadId, body }
 * Reply: { message: WireMessage }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { MAX_MESSAGE_LENGTH } from "@/components/messages/types";
import { appendMessage } from "../threads/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { threadId?: string; body?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const result = await appendMessage(
      String(body.threadId ?? ""),
      user.id,
      String(body.body ?? ""),
    );

    if (!result.ok) {
      switch (result.error) {
        case "not_participant":
          return NextResponse.json({ error: "No such thread." }, { status: 404 });
        case "empty":
          return NextResponse.json({ error: "Nothing to send." }, { status: 400 });
        case "too_long":
          return NextResponse.json(
            { error: `Messages max out at ${MAX_MESSAGE_LENGTH} characters.` },
            { status: 400 },
          );
      }
    }

    return NextResponse.json({ message: result.message });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
