/**
 * POST /api/exchange/[id]/events
 *
 * Append the next signed step to a session's chain: ciphertext_ack,
 * payment_signaled, dek_revealed, completed, or abort. The server re-verifies
 * the leaf's identity, its place in the hash-linked chain (seq and prev hash
 * against the current tip), the Ed25519 signature, the commitment cross-check,
 * the state-transition legality for the acting role, and the pinned-key rule.
 *
 * Body: { leaf, eventHash, signature, signerPubkey }
 * Reply: { session: SessionView }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { appendExchangeEvent, httpStatusFor, type SignedEventInput } from "../../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;

  let body: SignedEventInput;
  try {
    body = (await request.json()) as SignedEventInput;
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !body.leaf) {
    return NextResponse.json({ error: "Expected a signed event leaf." }, { status: 400 });
  }

  try {
    const result = await appendExchangeEvent(
      { id: user.id, username: user.username },
      id,
      body,
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, detail: result.detail },
        { status: httpStatusFor(result.error) },
      );
    }
    return NextResponse.json({ session: result.value });
  } catch (e) {
    if (e instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }
}
