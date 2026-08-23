/**
 * POST /api/auth/verify-and-signup
 *
 * Body:  { contact, realName, affiliation, code, challenge, username, password }
 * Reply: { username, accountType } and sets the session cookie.
 *
 * The one round trip where the attested fields come back. The server
 * recomputes the challenge HMAC over exactly what the client echoed; a match
 * proves contact, real name and affiliation are the same ones the code was
 * issued against. Then it persists ONLY: username, scrypt(password),
 * account_type, and HMAC(contact). realName and affiliation die with this
 * request. Nothing is logged.
 */

import { NextResponse } from "next/server";
import { verifyChallenge } from "@/lib/verify";
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  sessionCookieOptions,
  usernameProblem,
  usernameTaken,
} from "@/lib/auth";
import { passwordProblem } from "@/lib/crypto";
import { DbNotConfiguredError } from "@/lib/db";

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

  const badUsername = usernameProblem(body.username ?? "");
  if (badUsername) return NextResponse.json({ error: badUsername }, { status: 400 });

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
    if (await usernameTaken(body.username ?? "")) {
      return NextResponse.json({ error: "That username is taken." }, { status: 409 });
    }

    // normalizedContact goes into an HMAC inside createUser and nowhere else.
    const created = await createUser(
      body.username ?? "",
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

    const session = await createSession(created.user.id);
    const response = NextResponse.json({
      username: created.user.username,
      accountType: created.user.accountType,
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
