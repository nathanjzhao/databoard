/**
 * POST /api/exchange/[id]/wire
 *
 * Append the next WireCreditClaim step (Feature 1: the mutual proof-of-payment
 * that upgrades the exchange's pay step). The step is one of:
 *   wire_credit_claim        the seller, having observed the inbound credit,
 *                            signs the canonical claim + a salted commitment to
 *                            its receiving-bank record;
 *   wire_credit_countersign  the buyer countersigns that exact claim, reaching
 *                            wire_credit_observed, which is what gates the key
 *                            reveal;
 *   wire_reversed            either party appends this when the credit is
 *                            returned / frozen / recalled; it reopens the deal.
 *
 * The server re-verifies the leaf's identity and shape, its Ed25519 signature,
 * its place in the hash-linked wire chain (anchored to the payment_signaled
 * event), the N15 and claim-hash bindings, the wire sub-state transition for the
 * acting role, and the pinned-key rule. It stores commitments and signatures
 * only, never a bank name, account number, or wire receipt.
 *
 * Body: { leaf, eventHash, signature, signerPubkey }
 * Reply: { session: SessionView }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { appendWireClaim, httpStatusFor, type SignedEventInput } from "../../store";

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
    return NextResponse.json({ error: "Expected a signed wire-claim leaf." }, { status: 400 });
  }

  try {
    const result = await appendWireClaim({ id: user.id, username: user.username }, id, body);
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
