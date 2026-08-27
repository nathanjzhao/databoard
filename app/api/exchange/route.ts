/**
 * POST /api/exchange
 *
 * Open a commit-encrypt-pay-reveal session with its genesis commit. The body
 * is the seller's signed commit leaf; the server reads the deal id, the buyer,
 * and every commitment from the leaf itself, so the seller is bound only to
 * what they signed. Both parties must be CONFIRMED participants of the deal.
 *
 * Body: { leaf, eventHash, signature, signerPubkey }  (see lib/exchange.ts)
 * Reply 201: { session: SessionView }
 *
 * The server stores commitments, the signature, and the state; never the
 * dataset, the DEK, or any exact figure.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { createExchangeSession, httpStatusFor, type SignedEventInput } from "./store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: SignedEventInput;
  try {
    body = (await request.json()) as SignedEventInput;
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !body.leaf) {
    return NextResponse.json({ error: "Expected a signed commit leaf." }, { status: 400 });
  }

  try {
    const result = await createExchangeSession(
      { id: user.id, username: user.username },
      body,
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, detail: result.detail },
        { status: httpStatusFor(result.error) },
      );
    }
    return NextResponse.json({ session: result.value }, { status: 201 });
  } catch (e) {
    if (e instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }
}
