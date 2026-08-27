/**
 * POST /api/deals/[id]/receipt-sign
 *
 * One confirmed participant signs the deal's portable receipt with their own
 * Ed25519 key, turning a platform-MAC-only receipt into a party-attested one.
 * Body: { pubkey, sig }, both base64url, produced in the browser
 * (lib/receipt-attest signReceiptBase) over the canonical receipt bytes.
 *
 * The server never sees a private key. It re-derives the exact bytes the client
 * should have signed from the deal's current receipt state (so the signature is
 * bound to this tier, this buyer, this bucket, this translog seq), checks the
 * signature against the submitted pubkey, checks the pubkey is the caller's OWN
 * write-once registered signing key, and stores the row. Authorization is the
 * same as the rest of the deal surface: a deal the caller is not on answers
 * 404, indistinguishable from one that does not exist, and only a CONFIRMED
 * participant of an attested deal can sign.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError, now } from "@/lib/db";
import { getDealForUser } from "@/lib/deals";
import { loggedReceiptForDeal } from "@/lib/translog";
import { partyBaseFieldsFromPayload } from "@/lib/receipts";
import { partySigningBase, verifyPartySig, isPubkey, isSig } from "@/lib/receipt-attest";
import { storePartySig } from "@/lib/party-sigs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { pubkey?: string; sig?: string };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { id } = await params;
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const pubkey = String(body.pubkey ?? "");
  const sig = String(body.sig ?? "");
  if (!isPubkey(pubkey) || !isSig(sig)) {
    return NextResponse.json(
      { error: "Expected a base64url Ed25519 pubkey and signature." },
      { status: 400 },
    );
  }

  try {
    const deal = await getDealForUser(id, user.id);
    if (!deal) return NextResponse.json({ error: "No such deal." }, { status: 404 });
    if (deal.viewer.status !== "confirmed") {
      return NextResponse.json(
        { error: "Only a confirmed participant can sign this receipt." },
        { status: 409 },
      );
    }

    // Mint the current logged receipt: this fixes the translog seq the signature
    // commits to and hands back the signer roster the base is built over.
    const logged = await loggedReceiptForDeal(deal);
    if (!logged) {
      return NextResponse.json(
        { error: "This deal is not attested, so it mints no receipt to sign." },
        { status: 409 },
      );
    }
    const fields = partyBaseFieldsFromPayload(logged.payload);
    if (!fields || logged.payload.log == null) {
      return NextResponse.json(
        { error: "The transparency log is unavailable; try again in a moment." },
        { status: 503 },
      );
    }
    if (!fields.signers.some((s) => s.handle === user.username)) {
      return NextResponse.json(
        { error: "Register a signing key first (sign in again to register it)." },
        { status: 409 },
      );
    }

    const base = partySigningBase(fields);
    if (!verifyPartySig(base, pubkey, sig)) {
      return NextResponse.json(
        { error: "Signature does not verify against the receipt bytes." },
        { status: 400 },
      );
    }

    const result = await storePartySig({
      dealId: deal.id,
      userId: user.id,
      seq: fields.seq,
      pubkey,
      sig,
      now: now(),
    });
    if (!result.ok) {
      const message =
        result.error === "not_registered"
          ? "No signing key is registered for your account."
          : "The submitted key is not your registered signing key.";
      return NextResponse.json({ error: message }, { status: 409 });
    }

    return NextResponse.json({ ok: true, seq: fields.seq, stored: result.stored });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
