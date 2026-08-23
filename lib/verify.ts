/**
 * lib/verify.ts
 *
 * Stateless contact verification, with the identity attestation folded in.
 *
 * The usual design is: store (contact, code, expiry) in a table, look it up
 * when the user submits. That table is a list of everyone's phone numbers.
 * We do not want that table to exist, so there isn't one.
 *
 * Instead:
 *   1. Client posts contact + real name + affiliation. Server generates a
 *      6-digit code and computes
 *        challenge = expiry . HMAC(SERVER_PEPPER,
 *                      "otp" | contact | realName | affiliation | code | expiry)
 *      and returns the challenge. None of the fields is written down anywhere.
 *      The code goes out over the delivery channel.
 *   2. Client posts back all fields + code + challenge, once.
 *   3. Server recomputes the HMAC from what it was just given and compares.
 *      If it matches and the expiry is in the future, the contact is verified
 *      and the name/affiliation are ATTESTED: they were bound into the MAC, so
 *      they cannot have been swapped after the code went out. Then they are
 *      discarded. Only username, password hash, account type and the contact
 *      blind index are ever persisted (lib/auth.ts).
 *
 * The server therefore holds nothing between step 1 and step 3. The cost is
 * that a challenge is replayable until it expires; the signup route closes
 * that by consuming it into an account (contact_blind_index is UNIQUE) and
 * the window is five minutes.
 */

import { hmacHex, normalizeContact, detectContactKind, safeEqual } from "./crypto.ts";
import type { ContactKind } from "./crypto.ts";
import { INDEPENDENT_AFFILIATION } from "./taxonomy.ts";

export { INDEPENDENT_AFFILIATION };

/** Five minutes. Long enough to paste a code, short enough to not matter. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type AccountType = "org" | "individual";

export function accountTypeForAffiliation(affiliation: string): AccountType {
  return normalizeAttested(affiliation) === INDEPENDENT_AFFILIATION
    ? "individual"
    : "org";
}

/**
 * Demo mode returns the code in the API response and the UI prints it with a
 * loud label. Set BLIND_TENDER_DEMO=false to require real delivery.
 */
export const DEMO_MODE = process.env.BLIND_TENDER_DEMO !== "false";

export type IssuedChallenge = {
  /** Opaque string the client must send back untouched. */
  challenge: string;
  /** Epoch ms. Exposed so the UI can count down. */
  expiresAt: number;
  /** "email" or "phone", so the UI can say "we sent a text" correctly. */
  contactKind: ContactKind;
  /**
   * The plaintext code. SERVER SIDE ONLY. Hand it to deliverCode(). The only
   * place it may go out over the wire is the demo-mode branch of
   * /api/auth/request-code, which labels it as such in the UI.
   */
  code: string;
};

export type VerifyResult =
  | { ok: true; normalizedContact: string; accountType: AccountType }
  | {
      ok: false;
      reason: "invalid_contact" | "invalid_identity" | "malformed" | "expired" | "mismatch";
    };

function sixDigitCode(): string {
  // Not crypto-sensitive on its own (the HMAC is what binds it), but there is
  // no reason to use Math.random here.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

/**
 * Whitespace-collapse so an accidental double space between step 1 and the
 * echo does not fail the MAC. This is the entire lifetime of the name and the
 * affiliation on the server: into this function, into the HMAC, gone.
 */
function normalizeAttested(raw: string): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}

export function isPlausibleName(raw: string): boolean {
  const n = normalizeAttested(raw);
  return n.length >= 2 && n.length <= 120;
}

export function isPlausibleAffiliation(raw: string): boolean {
  const a = normalizeAttested(raw);
  return a.length >= 2 && a.length <= 160;
}

function mac(
  normalizedContact: string,
  realName: string,
  affiliation: string,
  code: string,
  expiresAt: number,
): string {
  // \x1f between fields so no concatenation of one field can imitate another.
  return hmacHex(
    "otp",
    [normalizedContact, realName, affiliation, code, expiresAt].join("\x1f"),
  );
}

/**
 * Step 1. Nothing is persisted by this call, and none of the arguments
 * outlives it. Throws if the contact, name or affiliation is unusable.
 */
export function issueChallenge(
  rawContact: string,
  realName: string,
  affiliation: string,
): IssuedChallenge {
  const normalized = normalizeContact(rawContact);
  const kind = detectContactKind(rawContact);
  if (!normalized || !kind) {
    throw new Error("Enter a phone number or an email address.");
  }
  if (!isPlausibleName(realName)) {
    throw new Error("Enter your real name. It is attested, not stored.");
  }
  if (!isPlausibleAffiliation(affiliation)) {
    throw new Error("Enter an organization, or mark yourself independent.");
  }

  const code = sixDigitCode();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const challenge = `${expiresAt}.${mac(
    normalized,
    normalizeAttested(realName),
    normalizeAttested(affiliation),
    code,
    expiresAt,
  )}`;

  return { challenge, expiresAt, contactKind: kind, code };
}

/**
 * Step 3. Recomputes the HMAC over exactly what the client sent back.
 * On success returns the normalized contact (so the caller can derive the
 * blind index) and the account type (the one bit of the affiliation that is
 * allowed to survive). The caller must not keep anything else.
 */
export function verifyChallenge(
  rawContact: string,
  realName: string,
  affiliation: string,
  code: string,
  challenge: string,
): VerifyResult {
  const normalized = normalizeContact(rawContact);
  if (!normalized) return { ok: false, reason: "invalid_contact" };

  const name = normalizeAttested(realName);
  const aff = normalizeAttested(affiliation);
  if (!isPlausibleName(name) || !isPlausibleAffiliation(aff)) {
    return { ok: false, reason: "invalid_identity" };
  }

  const dot = (challenge ?? "").indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const expiresAt = Number(challenge.slice(0, dot));
  const presented = challenge.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || !/^[0-9a-f]{64}$/.test(presented)) {
    return { ok: false, reason: "malformed" };
  }
  if (Date.now() > expiresAt) return { ok: false, reason: "expired" };

  const cleanCode = (code ?? "").replace(/\D/g, "");
  if (cleanCode.length !== 6) return { ok: false, reason: "mismatch" };

  if (!safeEqual(presented, mac(normalized, name, aff, cleanCode, expiresAt))) {
    return { ok: false, reason: "mismatch" };
  }
  return {
    ok: true,
    normalizedContact: normalized,
    accountType: accountTypeForAffiliation(aff),
  };
}

/* -------------------------------------------------------------- delivery */

export type DeliveryResult = {
  delivered: boolean;
  transport: "demo" | "sms" | "email" | "none";
  note?: string;
};

/**
 * Pluggable delivery stub. In demo mode it does nothing and the UI shows the
 * code. A production build swaps the bodies of the two branches below for a
 * Twilio call and a Resend call. Neither branch may log or store the contact.
 */
export async function deliverCode(
  rawContact: string,
  code: string,
  kind: ContactKind,
): Promise<DeliveryResult> {
  if (DEMO_MODE) {
    return {
      delivered: false,
      transport: "demo",
      note: "Demo mode. The code is shown on screen instead of being sent.",
    };
  }

  if (kind === "phone") {
    // TODO(production): Twilio messages.create({ to: rawContact, body: code })
    void rawContact;
    void code;
    return { delivered: false, transport: "none", note: "SMS transport not configured." };
  }

  // TODO(production): Resend emails.send({ to: rawContact, subject, text: code })
  return { delivered: false, transport: "none", note: "Email transport not configured." };
}

/** Human-readable description of where a code went, for the signup UI. */
export function deliveryBlurb(kind: ContactKind): string {
  if (DEMO_MODE) return "Demo mode: the code appears below instead of being sent.";
  return kind === "phone" ? "We sent a text." : "We sent an email.";
}
