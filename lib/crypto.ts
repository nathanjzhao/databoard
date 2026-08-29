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
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { buyerChip, normalizeBuyer, VOPRF_HKDF_LABEL } from "./voprf.ts";

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
 * Canonical form of an email, so that provider-level aliases of one inbox
 * collapse to one blind index. Applied before hashing:
 *   - lowercase the whole address;
 *   - drop a "+tag" suffix from the local part (everything from the first
 *     "+" up to the "@"); the major providers route "user+anything" to
 *     "user", so the tag mints no new mailbox;
 *   - for gmail.com / googlemail.com the dots in the local part are not
 *     significant, so strip them, and fold googlemail.com onto gmail.com.
 * Other providers keep their dots: elsewhere a dot can be a real second
 * mailbox, and collapsing it would merge two strangers.
 *
 * Input is assumed already validated as an email (detectContactKind, which
 * guarantees exactly one "@" and a non-empty local part). If stripping a
 * "+tag" would empty the local part (a pathological "+tag@host"), the strip
 * is skipped so the index stays non-empty and stable.
 */
export function canonicalizeEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email.trim().toLowerCase();
  let local = email.slice(0, at).trim().toLowerCase();
  let domain = email.slice(at + 1).trim().toLowerCase();

  // "+tag" is only significant to the sender; strip it. plus > 0 keeps a
  // degenerate "+tag@host" (empty local) from collapsing to just "@host".
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);

  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");

  return `${local}@${domain}`;
}

/**
 * Canonical form of a contact, so that aliases of one inbox or one phone
 * number produce the same blind index. Emails go through canonicalizeEmail
 * (lowercase, "+tag" stripped, gmail dots folded); phones reduce to digits,
 * with a bare 10-digit US number and its +1 form treated alike. Returns ""
 * when the input is not a usable contact.
 *
 * MIGRATION, stated plainly: tightening the email rule changes
 * contact_blind_index for NEW signups only. Rows written before this
 * canonicalization keep their old index, and there is no re-indexing pass,
 * because the raw contact was never stored and cannot be recomputed. Two
 * gmail aliases that each already hold an account stay two accounts; the
 * rule stops a THIRD alias of the same inbox from minting a fresh one.
 *
 * The return value is used immediately and never stored.
 */
export function normalizeContact(raw: string): string {
  const kind = detectContactKind(raw);
  if (!kind) return "";
  const t = raw.trim();
  if (kind === "email") return canonicalizeEmail(t);
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

// The normalization rule lives in lib/voprf.ts now, because the CLIENT is the
// one that normalizes before blinding; this re-export keeps the server side
// on the identical bytes.
export { normalizeBuyer };

/**
 * LEGACY v1 token: HMAC(SERVER_PEPPER, "buyer" | normalized). No request
 * handler mints these any more; the compose paths take a v2 OPRF token the
 * browser minted without the server seeing the name (lib/voprf.ts). This
 * function remains so scripts/migrate-buyer-tokens.ts can compute which old
 * rows to rewrite. Do not call it from a route.
 */
export function buyerToken(rawName: string): string {
  const normalized = normalizeBuyer(rawName);
  if (!normalized) throw new Error("Buyer name is empty after normalization.");
  return hmacHex("buyer", normalized);
}

/** The public handle for a buyer token: "Buyer #a4f1". Prefix-aware. */
export function buyerLabel(token: string): string {
  return `Buyer #${buyerChip(token)}`;
}

/** Just the four hex characters, for places that render the label themselves. */
export function buyerShort(token: string): string {
  return buyerChip(token);
}

/**
 * Seed for the server's VOPRF key: HKDF-SHA256 over SERVER_PEPPER with the
 * fixed info label "databoard-voprf-v1". The seed then goes through RFC 9497
 * DeriveKeyPair (app/api/voprf/server.ts) to become a valid scalar, so every
 * environment's OPRF key is a pure function of its pepper. Rotating the
 * pepper rotates this key too, which silently breaks token continuity unless
 * scripts/migrate-buyer-tokens.ts is re-run for the known-buyer rows.
 */
export function voprfKeySeed(): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", serverPepper(), "databoard", VOPRF_HKDF_LABEL, 32),
  );
}

/* -------------------------------------------------------------- passwords */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export const MIN_PASSWORD_LENGTH = 14;

/**
 * A small set of obviously-guessable passwords, normalized to lowercase
 * alphanumerics. This is not a breach corpus (that would need a service and a
 * data file); it is a floor against the handful of strings a casual attacker
 * tries first. The real defense is length + a passphrase; the durable defense
 * against the offline oracle is the per-user KDF salt (lib/e2ee.ts).
 */
const WEAK_PASSWORDS = new Set([
  "password",
  "passwordpassword",
  "passw0rd",
  "letmein",
  "letmeinletmein",
  "iloveyou",
  "welcome",
  "welcomewelcome",
  "welcome123",
  "changeme",
  "changemenow",
  "adminadmin",
  "administrator",
  "qwerty",
  "qwertyuiop",
  "qwertyuiopasdfgh",
  "azerty",
  "1234567890",
  "12345678901234",
  "123456789012345",
  "0123456789",
  "abcdefghijklmn",
  "abcdefghijklmnop",
]);

function distinctChars(p: string): number {
  return new Set(p).size;
}

/**
 * Null when the password is acceptable, a human-readable reason otherwise.
 *
 * The floor is deliberately above a short word or two: the signing/e2ee public
 * keys are derived from this password, and a public per-handle key directory
 * plus a weak password is an offline cracking target (F-01). The entropy check
 * is intentionally lenient so the app's own advice ("a sentence works") stays
 * true: a multi-word passphrase always passes; only very short, very
 * repetitive, or textbook-weak strings are refused.
 */
export function passwordProblem(raw: string): string | null {
  const p = raw ?? "";
  if (p.length < MIN_PASSWORD_LENGTH) {
    return `At least ${MIN_PASSWORD_LENGTH} characters. A short sentence or passphrase works.`;
  }
  if (p.length > 200) return "200 characters max.";
  // A single character repeated ("aaaaaaaaaaaaaa") or a tiny alphabet
  // ("ababab...") is long but trivially guessable.
  if (distinctChars(p) < 6) {
    return "Too repetitive. Use a longer passphrase with more variety.";
  }
  const normalized = p.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (WEAK_PASSWORDS.has(normalized) || WEAK_PASSWORDS.has(p.toLowerCase())) {
    return "That is a commonly guessed password. Pick a private passphrase.";
  }
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
