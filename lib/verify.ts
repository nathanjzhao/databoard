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
 * that by consuming it into an account (contact_blind_index is UNIQUE), the
 * window is ten minutes, and /api/auth/request-code is rate limited
 * (lib/ratelimit.ts).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { hmacHex, normalizeContact, detectContactKind, safeEqual } from "./crypto.ts";
import type { ContactKind } from "./crypto.ts";
import { INDEPENDENT_AFFILIATION } from "./taxonomy.ts";

export { INDEPENDENT_AFFILIATION };

/** Ten minutes. Long enough for a slow inbox, short enough to not matter. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** The expiry as delivery copy states it. Derived, so it cannot drift. */
const EXPIRY_MINUTES = Math.round(CHALLENGE_TTL_MS / 60_000);

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
  transport: "demo" | "sms" | "email" | "test" | "none";
  /** Why nothing went out, when transport is "none" in live mode. */
  failure?: "unconfigured" | "provider_error";
  note?: string;
};

/**
 * THE RULE FOR EVERYTHING BELOW: the contact and the code are never logged
 * and never stored. On a provider failure the only thing written anywhere is
 * the provider's name and the HTTP status.
 */

/**
 * Email goes out over SES when its scoped key pair is present, else over
 * Resend when that key is present. SES creds use SES_-prefixed names because
 * Vercel reserves the AWS_ prefix.
 */
function sesConfigured(): boolean {
  return Boolean(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY);
}

function emailConfigured(): boolean {
  return sesConfigured() || Boolean(process.env.RESEND_API_KEY);
}

/** SMS goes out when the full Twilio triple is present. */
function smsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM,
  );
}

/**
 * Which contact kinds can actually receive a code right now. The signup UI
 * uses this (returned alongside request-code errors) to grey out the phone
 * path when only email is configured, and vice versa.
 */
export function availableContactKinds(): ContactKind[] {
  if (DEMO_MODE || testCaptureEnabled()) return ["email", "phone"];
  const kinds: ContactKind[] = [];
  if (emailConfigured()) kinds.push("email");
  if (smsConfigured()) kinds.push("phone");
  return kinds;
}

/**
 * TEST TRANSPORT. With OTP_TEST_CAPTURE=1 the code is appended (kind + code
 * only, never the contact) to data/otp-capture.jsonl so the Playwright specs
 * can drive NON-demo mode end to end without a provider. Refused outright in
 * production: this would defeat delivery-based verification.
 */
function testCaptureEnabled(): boolean {
  if (process.env.OTP_TEST_CAPTURE !== "1") return false;
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("OTP_TEST_CAPTURE is a test transport. Refusing in production.");
  }
  return true;
}

function captureForTests(kind: ContactKind, code: string): void {
  const dir = path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    path.join(dir, "otp-capture.jsonl"),
    JSON.stringify({ kind, code }) + "\n",
    "utf8",
  );
}

/**
 * Twilio wants E.164. A leading "+" is honored as typed; a bare 10-digit
 * number is assumed US, the same assumption normalizeContact makes for the
 * blind index; anything longer is taken as already country-coded.
 */
function e164(rawContact: string): string {
  const digits = rawContact.replace(/\D/g, "");
  if (rawContact.trim().startsWith("+")) return `+${digits}`;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/**
 * Send over Amazon SES (SESv2 SendEmail). The client is constructed per call
 * with explicit credentials; the SDK import stays lazy so the function bundle
 * only pays for it when SES is actually configured.
 */
async function sendViaSes(rawContact: string, code: string): Promise<DeliveryResult> {
  const from = process.env.OTP_EMAIL_FROM || "DataBoard <code@send.taiku.live>";
  try {
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    const client = new SESv2Client({
      region: process.env.SES_REGION || "us-west-2",
      credentials: {
        accessKeyId: process.env.SES_ACCESS_KEY_ID!,
        secretAccessKey: process.env.SES_SECRET_ACCESS_KEY!,
      },
    });
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [rawContact] },
        Content: {
          Simple: {
            Subject: { Data: "Your DataBoard code" },
            Body: {
              Text: {
                Data: `${code} is your DataBoard verification code. It expires in ${EXPIRY_MINUTES} minutes. Ignore this email if you did not request it.`,
              },
            },
          },
        },
      }),
    );
    return { delivered: true, transport: "email" };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.warn(`otp: ses delivery failed, ${name}`);
    return { delivered: false, transport: "none", failure: "provider_error" };
  }
}

/** POST https://api.resend.com/emails. From address must be a verified domain. */
async function sendViaResend(rawContact: string, code: string): Promise<DeliveryResult> {
  const from = process.env.OTP_EMAIL_FROM || "DataBoard <code@databoard.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [rawContact],
        subject: "Your DataBoard code",
        text: `${code} is your DataBoard verification code. It expires in ${EXPIRY_MINUTES} minutes. Ignore this email if you did not request it.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`otp: resend delivery failed, HTTP ${res.status}`);
      return { delivered: false, transport: "none", failure: "provider_error" };
    }
    return { delivered: true, transport: "email" };
  } catch {
    console.warn("otp: resend delivery failed, no response");
    return { delivered: false, transport: "none", failure: "provider_error" };
  }
}

/** POST the Twilio 2010-04-01 Messages endpoint, basic-auth, form-encoded. */
async function sendViaTwilio(rawContact: string, code: string): Promise<DeliveryResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: e164(rawContact),
          From: process.env.TWILIO_FROM ?? "",
          Body: `DataBoard: ${code} is your verification code. It expires in ${EXPIRY_MINUTES} minutes. Ignore this if you did not request it.`,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.warn(`otp: twilio delivery failed, HTTP ${res.status}`);
      return { delivered: false, transport: "none", failure: "provider_error" };
    }
    return { delivered: true, transport: "sms" };
  } catch {
    console.warn("otp: twilio delivery failed, no response");
    return { delivered: false, transport: "none", failure: "provider_error" };
  }
}

/**
 * Sends the code, or explains why it cannot.
 *
 *   demo mode          -> nothing goes out; the UI shows the code, labeled.
 *   live + configured  -> Resend for email, Twilio for phone.
 *   live + capture on  -> the test transport above stands in for a provider.
 *   live + neither     -> delivered:false with failure "unconfigured"; the
 *                         route turns that into a 503 naming the capability.
 *
 * The contact exists in this function for the length of one provider call
 * and is never logged or stored, in any branch.
 */
export async function deliverCode(
  rawContact: string,
  code: string,
  kind: ContactKind,
): Promise<DeliveryResult> {
  const capture = testCaptureEnabled(); // throws rather than run in production
  if (capture) captureForTests(kind, code);

  if (DEMO_MODE) {
    return {
      delivered: false,
      transport: "demo",
      note: "Demo mode. The code is shown on screen instead of being sent.",
    };
  }

  if (kind === "phone") {
    if (smsConfigured()) return sendViaTwilio(rawContact, code);
    if (capture) return { delivered: true, transport: "test" };
    return {
      delivered: false,
      transport: "none",
      failure: "unconfigured",
      note: "SMS delivery is not configured.",
    };
  }

  if (sesConfigured()) return sendViaSes(rawContact, code);
  if (emailConfigured()) return sendViaResend(rawContact, code);
  if (capture) return { delivered: true, transport: "test" };
  return {
    delivered: false,
    transport: "none",
    failure: "unconfigured",
    note: "Email delivery is not configured.",
  };
}

/**
 * Human-readable description of where a code went, for the signup UI.
 * Deliberately generic in live mode: the server never echoes the contact
 * back; the client composes "we sent a code to ..." from its own state.
 */
export function deliveryBlurb(kind: ContactKind): string {
  if (DEMO_MODE) return "Demo mode: the code appears below instead of being sent.";
  return kind === "phone" ? "We sent a text." : "We sent an email.";
}
