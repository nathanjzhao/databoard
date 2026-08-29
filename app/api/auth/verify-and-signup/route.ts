/**
 * POST /api/auth/verify-and-signup
 *
 * Body:  { inviteCode, contact, realName, affiliation, code, challenge,
 *          username, password }
 * Reply: { username, accountType } and sets the session cookie.
 *
 * The one round trip where the attested fields come back. The server
 * recomputes the challenge HMAC over exactly what the client echoed; a match
 * proves contact, real name and affiliation are the same ones the code was
 * issued against. Then it persists ONLY: username, scrypt(password),
 * account_type, and HMAC(contact). realName and affiliation die with this
 * request. Nothing is logged.
 *
 * Invite-only: the invite code request-code already validated is SPENT here,
 * by one guarded UPDATE (used_by IS NULL), after the account row exists so
 * used_by can reference it. A code raced by two signups is spent once; the
 * losing request deletes its seconds-old, referenced-by-nothing user row and
 * reports the code taken. Consuming writes the permanent invite_edges row in
 * the same transaction.
 *
 * Rate limit (lib/ratelimit.ts): 10 attempts / 10 min per IP, counted in an
 * HMAC bucket so the IP is never stored raw.
 */

import { NextResponse } from "next/server";
import {
  RATE_LIMITS,
  checkRateLimit,
  requestIp,
  retryPhrase,
} from "@/lib/ratelimit";
import { generateHandle, suffixHandle } from "@/lib/handles";
import { verifyChallenge } from "@/lib/verify";
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  ensureKdfSalt,
  sessionCookieOptions,
  usernameTaken,
} from "@/lib/auth";
import { passwordProblem } from "@/lib/crypto";
import { checkInviteCode, consumeInvite } from "@/lib/invites";
import { DbNotConfiguredError, getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERIFY_ERRORS: Record<string, string> = {
  invalid_contact: "That contact is not usable.",
  invalid_identity: "Name or affiliation is missing. Start over.",
  malformed: "That verification challenge is not readable. Start over.",
  expired: "The code expired. Request a new one.",
  mismatch: "Wrong code, or the details changed since the code was sent.",
};

export async function POST(request: Request) {
  let body: {
    inviteCode?: string;
    contact?: string;
    realName?: string;
    affiliation?: string;
    code?: string;
    challenge?: string;
    username?: string;
    password?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const limited = await checkRateLimit(RATE_LIMITS.signupPerIp, requestIp(request));
  if (limited.limited) {
    return NextResponse.json(
      {
        error: `Too many signup attempts. Try again in ${retryPhrase(limited.retryAfterSeconds)}.`,
        retryAfterSeconds: limited.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(limited.retryAfterSeconds) },
      },
    );
  }

  const badPassword = passwordProblem(body.password ?? "");
  if (badPassword) return NextResponse.json({ error: badPassword }, { status: 400 });

  const verified = verifyChallenge(
    body.contact ?? "",
    body.realName ?? "",
    body.affiliation ?? "",
    body.code ?? "",
    body.challenge ?? "",
  );
  if (!verified.ok) {
    return NextResponse.json(
      { error: VERIFY_ERRORS[verified.reason] ?? "Verification failed." },
      { status: 400 },
    );
  }

  try {
    // Invite-only: refuse before creating anything when the code is already
    // gone. The atomic spend happens after the user row exists.
    const inviteState = await checkInviteCode(body.inviteCode ?? "");
    if (inviteState !== "ok") {
      return NextResponse.json(
        {
          error:
            inviteState === "used"
              ? "That invite code has been used."
              : "That invite code is not one we issued.",
        },
        { status: 400 },
      );
    }

    // The handle is assigned, never chosen (lib/handles.ts): a chosen name is
    // the one field a person could use to point back at themselves.
    let handle = generateHandle();
    for (let i = 0; i < 8 && (await usernameTaken(handle)); i++) {
      handle = i < 3 ? generateHandle() : suffixHandle(generateHandle());
    }

    // normalizedContact goes into an HMAC inside createUser and nowhere else.
    const created = await createUser(
      handle,
      body.password ?? "",
      verified.accountType,
      verified.normalizedContact,
    );
    if (!created.ok) {
      const message =
        created.error === "contact_taken"
          ? "There is already an account on that number or address. There is no recovery, by design."
          : created.error === "username_taken"
            ? "That username is taken."
            : "That username will not work.";
      return NextResponse.json({ error: message }, { status: 409 });
    }

    // Spend the code and write the genealogy edge, one guarded transaction.
    // A lost race deletes the seconds-old user row (nothing references it
    // yet: no session, no keys, no content) and reports the code taken.
    const consumed = await consumeInvite(body.inviteCode ?? "", created.user.id);
    if (!consumed.ok) {
      const db = await getDb();
      await db.execute({
        sql: `DELETE FROM users WHERE id = ?`,
        args: [created.user.id],
      });
      return NextResponse.json(
        { error: "That invite code was claimed a moment ago by someone else." },
        { status: 409 },
      );
    }

    // Mint the per-user KDF salt now and hand it back with the session, so the
    // browser derives its identity keys under a salt tied to this account and
    // not to the public handle alone (F-01).
    const kdfSalt = await ensureKdfSalt(created.user.id);
    const session = await createSession(created.user.id);
    const response = NextResponse.json({
      username: created.user.username,
      accountType: created.user.accountType,
      kdfSalt,
    });
    response.cookies.set(
      SESSION_COOKIE,
      session.token,
      sessionCookieOptions(session.expiresAt),
    );
    return response;
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
