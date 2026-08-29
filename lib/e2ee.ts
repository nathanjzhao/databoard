/**
 * lib/e2ee.ts
 *
 * End-to-end encryption for messages: every primitive in one isomorphic
 * module. It runs unchanged in the browser (thread views, signup, login),
 * under plain node (scripts/seed.ts encrypts the demo threads with this
 * exact code), and on the server (which only ever calls the shape check,
 * because the server holds no keys and can open nothing).
 *
 * The design, in full:
 *
 *   Identity keys.  An X25519 keypair derived CLIENT-SIDE from the user's
 *   password: seed = scrypt(password, "databoard-e2ee-v1:" + username [+
 *   0x1f + kdfSalt], N=2^15, r=8, p=1, 32 bytes), private key = clamp(seed),
 *   public key = X25519 base point mult. The public half is uploaded once at
 *   signup and is write-once server-side. The private half is recomputed at
 *   login and lives in sessionStorage for the tab, never sent anywhere.
 *   Passwords are unchangeable here (no recovery exists), so the derivation is
 *   stable for the life of the account. The server's password_hash uses scrypt
 *   with a random per-user salt (lib/crypto.ts), a disjoint salt domain, so the
 *   two derivations can never produce related output.
 *
 *   kdfSalt is a high-entropy, server-held, per-user value (user_kdf_salt)
 *   handed to the client ONLY inside that user's own authenticated login /
 *   signup response, i.e. only after the password check. Folding it into the
 *   scrypt salt means the published public key is no longer a pure function of
 *   (password, handle): an attacker who fetches a handle's public key can no
 *   longer brute-force the password offline, because the salt for that handle
 *   is never served to them. It is optional here so the isomorphic callers
 *   (scripts, tests, legacy pre-salt accounts) can still derive the original
 *   unsalted keys; production login/signup always pass it. The derivation stays
 *   deterministic per device: the salt is write-once, so every device re-fetches
 *   the same bytes and derives the same keys.
 *
 *   Thread keys.  A random 32-byte AES-256-GCM key per thread, generated in
 *   the first participant's browser to open the thread, then wrapped for
 *   every participant crypto_box-style: fresh ephemeral X25519 keypair,
 *   shared = X25519(eph_priv, recipient_pub), wrap key = HKDF-SHA256(shared,
 *   salt="databoard-e2ee-v1/wrap", info=eph_pub || recipient_pub, 32), then
 *   AES-256-GCM over the thread key with a random 12-byte nonce and
 *   AAD "databoard-e2ee-v1/key/" + threadId (so a wrap cannot be replayed
 *   into a different thread).
 *
 *   Messages.  AES-256-GCM under the thread key, random 12-byte nonce, AAD
 *   "databoard-e2ee-v1/msg/" + threadId. The stored body is the envelope
 *   "e2ee-v1-" + b64url(nonce) + b64url(ciphertext): one string in the
 *   base64url alphabet, parsed by position (the nonce is always 16 chars).
 *
 * AES-GCM comes from WebCrypto (globalThis.crypto.subtle), which exists in
 * every browser and in node 20+, so the only dependencies are @noble/curves
 * and @noble/hashes, both audited and zero-dependency.
 *
 * Honest limits, so nobody reads more into this than it does:
 *   - Metadata is not encrypted: who talks to whom, when, and thread
 *     subjects are visible to the operator.
 *   - No forward secrecy: the keys are deterministic from the password, so
 *     anyone who learns the password derives the same private key. That is
 *     the deliberate trade for accounts with no recovery channel; it is
 *     also what makes a second device work at all.
 *   - The guarantee is against the database, not against the code path: an
 *     operator serving tampered JavaScript could exfiltrate keys (the
 *     WhatsApp / Code Verify problem). Open code and public CI make that
 *     tampering detectable, not impossible.
 */

import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/* ------------------------------------------------------------- constants */

export const E2EE_VERSION = "e2ee-v1";

const IDENTITY_SALT_PREFIX = "databoard-e2ee-v1:";
/**
 * HKDF domain that splits the Ed25519 SIGNING key off the same scrypt seed as
 * the X25519 encryption key. A distinct info domain from the wrap key below, so
 * the signing public key is unrelated to the encryption public key even though
 * both come from one scrypt. This derivation is SHARED with lib/exchange.ts
 * (which imports the seed path from here); the two must agree byte-for-byte,
 * because both register into the one user_signing_keys row and verify against
 * it. Keep this constant identical there.
 */
const SIGNING_HKDF_DOMAIN = "databoard-e2ee-v1/sign";
const WRAP_HKDF_SALT = "databoard-e2ee-v1/wrap";
const KEY_AAD_PREFIX = "databoard-e2ee-v1/key/";
const MSG_AAD_PREFIX = "databoard-e2ee-v1/msg/";

const SCRYPT_N = 2 ** 15; // deliberately not the server's params or salt
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const NONCE_BYTES = 12; // AES-GCM standard nonce; 16 base64url chars
const ENVELOPE_PREFIX = `${E2EE_VERSION}-`; // "e2ee-v1-"
const NONCE_B64_LEN = 16;

/**
 * Strict envelope shape: prefix, 16 base64url chars of nonce, then at least
 * a GCM tag plus one byte of ciphertext. Everything after the prefix is in
 * the base64url alphabet on purpose, no inner separators: the whole stored
 * body stays a single opaque token, and the proof suites' PII scanners
 * treat it as the random bytes it is.
 */
const ENVELOPE_RE = /^e2ee-v1-[A-Za-z0-9_-]{39,}$/;

/** Public keys are 32 bytes = 43 base64url chars; wraps are 12 + 32 + 16 bytes = 80 chars. */
export const PUBKEY_B64_LEN = 43;
export const WRAPPED_KEY_B64_LEN = 80;

/* --------------------------------------------------------------- base64url */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET[i]] = i;

/** Uint8Array -> base64url, no padding. Hand-rolled so browser and node agree. */
export function toB64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += B64_ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += B64_ALPHABET[c & 63];
  }
  return out;
}

/**
 * base64url -> Uint8Array. Returns null on any character, length, or
 * NON-CANONICAL encoding.
 *
 * Canonicalization guard (N-01): a base64url string with non-zero trailing bits
 * (e.g. a 43-char 32-byte key carries 258 bits, 2 of them unused) decodes to the
 * same bytes as its canonical form, so two distinct strings could otherwise map
 * to one key/sig/token. Every key, signature, token, nonce, wrap and ciphertext
 * blob on the platform is produced by toB64url, so a canonical input always
 * re-encodes to itself; we reject anything that does not, which keeps the STRING
 * form of a value 1:1 with its bytes. Write-once key registration, dedup, and
 * every equality/index check on the string form depend on that 1:1-ness.
 */
export function fromB64url(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length % 4 === 1) return null;
  const len = Math.floor((s.length * 3) / 4);
  const out = new Uint8Array(len);
  let buffer = 0;
  let bits = 0;
  let j = 0;
  for (const ch of s) {
    const v = B64_LOOKUP[ch];
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (buffer >> bits) & 0xff;
    }
  }
  // Reject any string that is not the unique canonical encoding of `out`.
  if (toB64url(out) !== s) return null;
  return out;
}

/* ---------------------------------------------------------------- helpers */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** True when every byte is zero. OR-accumulated so it does not short-circuit. */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const b of bytes) acc |= b;
  return acc === 0;
}

/**
 * Domain-separated signing input: a length-delimited frame that binds a fixed
 * context tag to canonical body bytes, so a signature made by one identity key
 * in one context can never verify in another (N-02). Layout:
 *
 *   [tagLen: 1 byte] || tag (utf8) || body (utf8)
 *
 * The one length byte delimits the tag from the body with no reliance on a
 * separator byte being absent from either, and the tag carries a "/vN" so a
 * signing-format change is simply a new domain. The `body` is the explicit,
 * key-sorted canonicalJson (lib/merkle.ts / lib/receipts.ts), identical in the
 * browser and on the server; framing it this way replaces any dependence on
 * incidental JSON ordering. SHARED by lib/receipt-attest.ts (receipt
 * attestations) and lib/exchange.ts (exchange events, wire claims), which pass
 * three DISJOINT tags; keep this helper the single definition so both sides
 * frame byte-for-byte identically.
 */
export function domainSeparatedSigningBytes(tag: string, body: string): Uint8Array {
  const tagBytes = utf8(tag);
  if (tagBytes.length > 255) throw new Error("domain tag too long");
  const bodyBytes = utf8(body);
  const out = new Uint8Array(1 + tagBytes.length + bodyBytes.length);
  out[0] = tagBytes.length;
  out.set(tagBytes, 1);
  out.set(bodyBytes, 1 + tagBytes.length);
  return out;
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw as unknown as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesSeal(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const key = await aesKey(keyBytes);
  const ct = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as unknown as BufferSource,
      additionalData: aad as unknown as BufferSource,
    },
    key,
    plaintext as unknown as BufferSource,
  );
  return new Uint8Array(ct);
}

/** Returns null on any authentication failure instead of throwing. */
async function aesOpen(
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const key = await aesKey(keyBytes);
    const pt = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce as unknown as BufferSource,
        additionalData: aad as unknown as BufferSource,
      },
      key,
      ciphertext as unknown as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- identity keys */

export type IdentityKeys = {
  /** base64url X25519 public key: uploaded at signup, stored server-side. */
  publicKey: string;
  /** Raw private scalar: stays in this device's memory or sessionStorage. */
  secretKey: Uint8Array;
};

/**
 * The one derivation. Same password + same username [+ same server-delivered
 * kdfSalt] = same keypair, on any device, forever, which is exactly the
 * property an account with no password changes and no recovery can honestly
 * offer. The salt domain ("databoard-e2ee-v1:" + username [+ 0x1f + kdfSalt])
 * shares nothing with the server-side password hash, whose salt is 16 random
 * bytes per user.
 *
 * kdfSalt (user_kdf_salt) is the per-user, server-held value handed to the
 * client only inside its own authenticated login/signup response. Mixing it in
 * is what stops the published public key from being a pure, offline-checkable
 * function of (password, handle). It is optional so the isomorphic callers
 * (scripts, tests, legacy pre-salt accounts) keep deriving the original keys;
 * pass it wherever a real account's keys must match what login registered.
 */
export async function deriveIdentityKeys(
  username: string,
  password: string,
  kdfSalt?: string,
): Promise<IdentityKeys> {
  const saltInput = kdfSalt
    ? IDENTITY_SALT_PREFIX + username + "\x1f" + kdfSalt
    : IDENTITY_SALT_PREFIX + username;
  const seed = await scryptAsync(
    utf8(password),
    utf8(saltInput),
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: 32 },
  );
  // getPublicKey clamps the scalar per RFC 7748 before the base point mult.
  const publicKey = x25519.getPublicKey(seed);
  return { publicKey: toB64url(publicKey), secretKey: seed };
}

/* --------------------------------------------------------- signing keys */

export type SigningKeys = {
  /** base64url Ed25519 public key (43 chars): registered like the e2ee pubkey. */
  publicKey: string;
  /** Raw 32-byte Ed25519 seed: stays in this device's memory or sessionStorage. */
  secretKey: Uint8Array;
};

/**
 * The account's Ed25519 signing keypair, sibling of deriveIdentityKeys above.
 * Same password + username = the same keypair on any device, forever, which is
 * the only property an account with no password change and no recovery can
 * honestly offer. It REUSES the e2ee scrypt seed and splits an Ed25519 key off
 * it with HKDF-SHA256 under SIGNING_HKDF_DOMAIN, so the one expensive scrypt
 * serves both keys and the signing public key is still unrelated to the
 * encryption public key. This derivation is SHARED with lib/exchange.ts and
 * must stay byte-identical there: both register into the one user_signing_keys
 * row and verify against it.
 *
 * The signature use is public-key, not shared-secret: a receipt or an exchange
 * step signed with this key proves the NAMED PARTY attested, a thing the
 * platform (holding no private key) cannot forge.
 *
 * kdfSalt threads through to deriveIdentityKeys, so the signing key inherits
 * the same per-user salting: a real account's signing key must be derived with
 * the same kdfSalt that login registered, or it will not match the directory.
 */
export async function deriveSigningKeys(
  username: string,
  password: string,
  kdfSalt?: string,
): Promise<SigningKeys> {
  const { secretKey: seed } = await deriveIdentityKeys(username, password, kdfSalt);
  return signingKeysFromSeed(seed, username);
}

/**
 * The signing keypair from an already-computed e2ee seed. Callers that already
 * hold the unlocked e2ee secret key (the login form, the keystore) use this to
 * avoid a second scrypt; the standalone path above computes the seed first.
 */
export function signingKeysFromSeed(seed: Uint8Array, username: string): SigningKeys {
  const signingSeed = hkdf(sha256, seed, utf8(SIGNING_HKDF_DOMAIN), utf8(username), 32);
  return { publicKey: toB64url(ed25519.getPublicKey(signingSeed)), secretKey: signingSeed };
}

/* ------------------------------------------------------------ thread keys */

/** A fresh random 32-byte AES-256-GCM key for one thread. */
export function generateThreadKey(): Uint8Array {
  return randomBytes(32);
}

export type WrappedKey = {
  /** base64url: 12-byte nonce || AES-GCM ciphertext of the thread key. */
  wrappedKey: string;
  /** base64url X25519 ephemeral public key minted for this one wrap. */
  ephPubkey: string;
};

function wrapKdf(
  shared: Uint8Array,
  ephPub: Uint8Array,
  recipientPub: Uint8Array,
): Uint8Array {
  return hkdf(
    sha256,
    shared,
    utf8(WRAP_HKDF_SALT),
    concatBytes(ephPub, recipientPub),
    32,
  );
}

/**
 * Wrap a thread key for one recipient, crypto_box-style. The AAD binds the
 * wrap to its thread so the server cannot re-serve it under another thread.
 */
export async function wrapThreadKey(
  threadKey: Uint8Array,
  recipientPubkeyB64: string,
  threadId: string,
): Promise<WrappedKey | null> {
  const recipientPub = fromB64url(recipientPubkeyB64);
  if (!recipientPub || recipientPub.length !== 32) return null;
  try {
    const ephSecret = x25519.utils.randomSecretKey();
    const ephPub = x25519.getPublicKey(ephSecret);
    const shared = x25519.getSharedSecret(ephSecret, recipientPub);
    // Reject an all-zero shared secret: a low-order recipient key drives the
    // ladder to zero, which noble already throws on, but check it explicitly so
    // the guarantee does not silently rest on the library's internals.
    if (isAllZero(shared)) return null;
    const wrapKey = wrapKdf(shared, ephPub, recipientPub);
    const nonce = randomBytes(NONCE_BYTES);
    const ct = await aesSeal(wrapKey, nonce, threadKey, utf8(KEY_AAD_PREFIX + threadId));
    return {
      wrappedKey: toB64url(concatBytes(nonce, ct)),
      ephPubkey: toB64url(ephPub),
    };
  } catch {
    return null; // low-order point or other curve refusal
  }
}

/** Unwrap with the recipient's private key. Null on any failure, never throws. */
export async function unwrapThreadKey(
  wrappedKeyB64: string,
  ephPubkeyB64: string,
  mySecretKey: Uint8Array,
  threadId: string,
): Promise<Uint8Array | null> {
  const wrapped = fromB64url(wrappedKeyB64);
  const ephPub = fromB64url(ephPubkeyB64);
  if (!wrapped || wrapped.length <= NONCE_BYTES + 16) return null;
  if (!ephPub || ephPub.length !== 32) return null;
  try {
    const myPub = x25519.getPublicKey(mySecretKey);
    const shared = x25519.getSharedSecret(mySecretKey, ephPub);
    // Reject an all-zero shared secret from a low-order ephemeral point (see wrap).
    if (isAllZero(shared)) return null;
    const wrapKey = wrapKdf(shared, ephPub, myPub);
    const nonce = wrapped.slice(0, NONCE_BYTES);
    const ct = wrapped.slice(NONCE_BYTES);
    const key = await aesOpen(wrapKey, nonce, ct, utf8(KEY_AAD_PREFIX + threadId));
    return key && key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- messages */

/**
 * Seal one message body into the stored envelope. The AAD ties the
 * ciphertext to its thread: a message row copied into another thread's
 * history fails authentication instead of decrypting.
 */
export async function sealMessage(
  threadKey: Uint8Array,
  threadId: string,
  text: string,
): Promise<string> {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = await aesSeal(threadKey, nonce, utf8(text), utf8(MSG_AAD_PREFIX + threadId));
  return ENVELOPE_PREFIX + toB64url(nonce) + toB64url(ct);
}

/** Open one envelope. Null on tampering, wrong key, or wrong thread. */
export async function openMessage(
  threadKey: Uint8Array,
  threadId: string,
  envelope: string,
): Promise<string | null> {
  if (!isEnvelope(envelope)) return null;
  const body = envelope.slice(ENVELOPE_PREFIX.length);
  const nonce = fromB64url(body.slice(0, NONCE_B64_LEN));
  const ct = fromB64url(body.slice(NONCE_B64_LEN));
  if (!nonce || nonce.length !== NONCE_BYTES || !ct || ct.length < 17) return null;
  const pt = await aesOpen(threadKey, nonce, ct, utf8(MSG_AAD_PREFIX + threadId));
  return pt === null ? null : textDecoder.decode(pt);
}

/**
 * Is this stored body an encrypted envelope? The server uses this to refuse
 * plaintext writes into encrypted threads; clients use it to route a body
 * to decryption or straight to render. Strict on purpose: prefix, exact
 * alphabet, minimum length. A human would have to type 39+ base64url
 * characters behind the exact version tag to spoof it, and the worst that
 * mistype earns is a "could not decrypt" label on their own message.
 */
export function isEnvelope(body: string): boolean {
  return ENVELOPE_RE.test(body);
}
