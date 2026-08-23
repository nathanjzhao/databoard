/**
 * POST /api/auth/request-code
 *
 * Body:  { contact, realName, affiliation }
 *          contact      phone or email, either is fine
 *          affiliation  an org name, or exactly "independent individual"
 * Reply: { challenge, expiresAt, contactKind, demo, demoCode?, blurb }
 *
 * Nothing is written to the database by this route. Contact, name and
 * affiliation exist in memory for the length of this function, get bound
 * into the HMAC challenge, and are not logged or stored.
 */

import { NextResponse } from "next/server";
import { DEMO_MODE, deliverCode, deliveryBlurb, issueChallenge } from "@/lib/verify";
import { detectContactKind } from "@/lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { contact?: string; realName?: string; affiliation?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const contact = (body.contact ?? "").trim();
  const kind = detectContactKind(contact);
  if (!kind) {
    return NextResponse.json(
      { error: "That does not look like a phone number or an email address." },
      { status: 400 },
    );
  }

  let issued;
  try {
    issued = issueChallenge(contact, body.realName ?? "", body.affiliation ?? "");
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const delivery = await deliverCode(contact, issued.code, kind);

  return NextResponse.json({
    challenge: issued.challenge,
    expiresAt: issued.expiresAt,
    contactKind: issued.contactKind,
    demo: DEMO_MODE,
    demoCode: DEMO_MODE ? issued.code : undefined,
    blurb: deliveryBlurb(kind),
    transport: delivery.transport,
  });
}
