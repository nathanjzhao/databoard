/**
 * lib/crypto.ts
 *
 * Every one-way transform in DataBoard lives here. Nothing else in the app
 * should call node:crypto directly.
 *
 * The single secret is SERVER_PEPPER. It is not per-row salt: it is a fixed
 * server-side key, which is what makes the blind indexes stable enough to use
 * as UNIQUE constraints and as "same buyer" equality on the board. Everything
 * derived from it is namespaced so a contact index and a buyer token can never
 * collide even if someone signs up with a phone number spelled like a lab.
 */

import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";

/** Dev-only fallback. Real deployments set SERVER_PEPPER in the environment. */
const DEV_PEPPER = "dev-pepper-not-for-production-0000000000000000";

export function serverPepper(): string {
  const p = process.env.SERVER_PEPPER;
  if (p && p.length > 0) return p;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SERVER_PEPPER is not set. Refusing to start with the dev pepper in production.",
    );
  }
  return DEV_PEPPER;
}

/** True when the pepper is still the checked-in dev value. Shown on /transparency. */
export function isUsingDevPepper(): boolean {
  return serverPepper() === DEV_PEPPER;
}

/**
 * HMAC-SHA256 keyed with the server pepper, hex encoded.
 * `domain` keeps the keyspaces separate ("contact", "buyer", "otp", ...).
 */
export function hmacHex(domain: string, value: string): string {
  return createHmac("sha256", serverPepper())
    .update(domain, "utf8")
    .update("\x1f", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/* -------------------------------------------------------------- contacts */

export type ContactKind = "email" | "phone";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

/** Guesses whether a raw string is meant as an email or a phone number. */
export function detectContactKind(raw: string): ContactKind | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (t.includes("@")) return EMAIL_RE.test(t.toLowerCase()) ? "email" : null;
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 7 && digits.length <= 15) return "phone";
  return null;
}

/**
 * Canonical form of a contact, so that "+1 (415) 555-0142" and "14155550142"
 * produce the same blind index. Emails lowercase and trim; phones reduce to
 * digits only. Returns "" when the input is not a usable contact.
 *
 * The return value is used immediately and never stored.
 */
export function normalizeContact(raw: string): string {
  const kind = detectContactKind(raw);
  if (!kind) return "";
  const t = raw.trim();
  if (kind === "email") return t.toLowerCase();
  const digits = t.replace(/\D/g, "");
  // Treat a bare 10-digit US number and its +1 form as the same contact.
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export function isValidContact(raw: string): boolean {
  return normalizeContact(raw).length > 0;
}

/**
 * The only durable trace of a contact anywhere in the system.
 * HMAC(SERVER_PEPPER, "contact" | normalized). Used solely for the UNIQUE
 * constraint on users.contact_blind_index.
 */
export function contactBlindIndex(rawContact: string): string {
  const normalized = normalizeContact(rawContact);
  if (!normalized) throw new Error("Not a valid phone number or email address.");
  return hmacHex("contact", normalized);
}

/* ---------------------------------------------------------------- buyers */

/** Casefold, collapse whitespace, drop punctuation, so "Open AI" == "OpenAI". */
export function normalizeBuyer(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * HMAC(SERVER_PEPPER, "buyer" | normalized). The lab name is received over the
 * wire, passed through here, and discarded in the same request.
 */
export function buyerToken(rawName: string): string {
  const normalized = normalizeBuyer(rawName);
  if (!normalized) throw new Error("Buyer name is empty after normalization.");
  return hmacHex("buyer", normalized);
}

/** The public handle for a buyer token: "Buyer #a4f1". */
export function buyerLabel(token: string): string {
  return `Buyer #${token.slice(0, 4)}`;
}

/** Just the four hex characters, for places that render the label themselves. */
export function buyerShort(token: string): string {
  return token.slice(0, 4);
}

/* -------------------------------------------------------------- passwords */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export const MIN_PASSWORD_LENGTH = 10;

/** Null when the password is acceptable, a human-readable reason otherwise. */
export function passwordProblem(raw: string): string | null {
  const p = raw ?? "";
  if (p.length < MIN_PASSWORD_LENGTH) {
    return `At least ${MIN_PASSWORD_LENGTH} characters. A sentence works.`;
  }
  if (p.length > 200) return "200 characters max.";
  return null;
}

/**
 * scrypt with a random per-user salt, parameters stored alongside so they can
 * be raised later without invalidating old rows. There is deliberately no
 * password reset anywhere in the app: nothing stored could deliver one.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = (stored ?? "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
    const derived = scryptSync(
      password ?? "",
      Buffer.from(saltHex, "hex"),
      hashHex.length / 2,
      { N: Number(nStr), r: Number(rStr), p: Number(pStr) },
    );
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- tokens */

/** URL-safe random token, used for session tokens and row ids. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Row identifier: short, sortable-ish prefix plus randomness. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/** Constant-time string compare for hex/base64 tokens of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a ?? "", "utf8");
  const bb = Buffer.from(b ?? "", "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
