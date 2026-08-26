/**
 * POST /api/auth/request-code
 *
 * Body:  { inviteCode, contact, realName, affiliation }
 *          inviteCode   required; the board is invite-only
 *          contact      phone or email, either is fine
 *          affiliation  an org name, or exactly "independent individual"
 * Reply: { challenge, expiresAt, contactKind, demo, demoCode?, blurb,
 *          transport, contactKinds }
 *
 * The invite code is checked FIRST, before the contact is even looked at:
 * an unknown or spent code gets a terse error and the attested fields go
 * nowhere. The code is only read here; it is spent atomically later, by
 * verify-and-signup, so an abandoned signup never burns it.
 *
 * Nothing is written to the database by this route except rate-limit
 * counters keyed by HMAC buckets (lib/ratelimit.ts). Contact, name and
 * affiliation exist in memory for the length of this function, get bound
 * into the HMAC challenge, and are not logged or stored.
 *
 * Rate limits: 10 invite checks / 10 min per IP, then 5 codes / 10 min per
 * contact, 20 / 10 min per IP. In live mode (BLIND_TENDER_DEMO=false) a
 * missing delivery provider is a 503 whose copy names the capability
 * generically, plus contactKinds so the UI can steer people to the kind
 * that works.
 */

import { NextResponse } from "next/server";
import {
  DEMO_MODE,
  availableContactKinds,
  deliverCode,
  deliveryBlurb,
  issueChallenge,
} from "@/lib/verify";
import { detectContactKind, normalizeContact } from "@/lib/crypto";
import { checkInviteCode } from "@/lib/invites";
import { DbNotConfiguredError } from "@/lib/db";
import {
  RATE_LIMITS,
  checkRateLimit,
  requestIp,
  retryPhrase,
  worstOf,
} from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: {
    inviteCode?: string;
    contact?: string;
    realName?: string;
    affiliation?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  // Invite-only: the code is validated before the contact step does
  // anything at all. Its own limiter dimension counts every attempt.
  const inviteLimited = await checkRateLimit(
    RATE_LIMITS.inviteCheckPerIp,
    requestIp(request),
  );
  if (inviteLimited.limited) {
    return NextResponse.json(
      {
        error: `Too many invite checks. Try again in ${retryPhrase(inviteLimited.retryAfterSeconds)}.`,
        retryAfterSeconds: inviteLimited.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(inviteLimited.retryAfterSeconds) },
      },
    );
  }
  try {
    const invite = await checkInviteCode(body.inviteCode ?? "");
    if (invite !== "ok") {
      return NextResponse.json(
        {
          error:
            invite === "used"
              ? "That invite code has been used."
              : "That invite code is not one we issued.",
        },
        { status: 400 },
      );
    }
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const contact = (body.contact ?? "").trim();
  const kind = detectContactKind(contact);
  if (!kind) {
    return NextResponse.json(
      { error: "That does not look like a phone number or an email address." },
      { status: 400 },
    );
  }

  // Both dimensions count this attempt; either can refuse it. The keys go
  // straight into HMAC buckets and are never stored raw.
  const limited = worstOf(
    ...(await Promise.all([
      checkRateLimit(RATE_LIMITS.requestCodePerContact, normalizeContact(contact)),
      checkRateLimit(RATE_LIMITS.requestCodePerIp, requestIp(request)),
    ])),
  );
  if (limited.limited) {
    return NextResponse.json(
      {
        error: `Too many codes requested. Try again in ${retryPhrase(limited.retryAfterSeconds)}.`,
        retryAfterSeconds: limited.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(limited.retryAfterSeconds) },
      },
    );
  }

  let issued;
  try {
    issued = issueChallenge(contact, body.realName ?? "", body.affiliation ?? "");
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const delivery = await deliverCode(contact, issued.code, kind);

  if (!DEMO_MODE && !delivery.delivered) {
    const unconfigured = delivery.failure === "unconfigured";
    return NextResponse.json(
      {
        error: unconfigured
          ? kind === "phone"
            ? "SMS delivery is not configured."
            : "Email delivery is not configured."
          : "The code could not be sent. Try again in a minute.",
        contactKinds: availableContactKinds(),
      },
      { status: unconfigured ? 503 : 502 },
    );
  }

  return NextResponse.json({
    challenge: issued.challenge,
    expiresAt: issued.expiresAt,
    contactKind: issued.contactKind,
    demo: DEMO_MODE,
    demoCode: DEMO_MODE ? issued.code : undefined,
    blurb: deliveryBlurb(kind),
    transport: delivery.transport,
    contactKinds: availableContactKinds(),
  });
}
