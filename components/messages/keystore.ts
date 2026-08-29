/**
 * components/messages/keystore.ts
 *
 * Where the browser keeps the E2EE private key between page loads: one
 * sessionStorage entry for the tab. sessionStorage on purpose, not
 * localStorage and not a cookie: it dies with the tab, never rides on a
 * request, and never crosses origins. The key inside it is the X25519
 * private scalar re-derived from the password at login (lib/e2ee.ts); the
 * server never sees it, so nothing here is ever sent anywhere.
 *
 * The entry is tagged with the username it belongs to, and every read
 * verifies the tag: a stale key left by a previous account in the same tab
 * is treated as absent (and overwritten by the next sign-in) rather than
 * ever being used to wrap keys for the wrong identity.
 *
 * A new tab starts empty even while the session cookie is valid. That is
 * the honest consequence of never persisting the key: threads render with
 * "encrypted message" placeholders until the user unlocks with their
 * password (verified against the registered public key) or signs in again.
 */

import {
  deriveIdentityKeys,
  signingKeysFromSeed,
  fromB64url,
  toB64url,
} from "@/lib/e2ee";

const STORAGE_KEY = "databoard.e2ee.v1";

/**
 * The per-user KDF salt (user_kdf_salt), cached for the tab. It is mixed into
 * the identity-key derivation (lib/e2ee.ts) so the published public keys are
 * not a pure function of (password, handle) (F-01). Login and signup hand it
 * back in their responses and prime this cache; flows that re-derive from the
 * password without a fresh login (the thread unlock, the exchange stepper, the
 * party-signature panel) fetch it from /api/auth/kdf-salt against their session.
 */
let saltCache: { username: string; salt: string } | null = null;

/** Seed the salt cache from a login/signup response. */
export function primeKdfSalt(username: string, salt: string | undefined | null): void {
  if (typeof salt === "string" && salt.length > 0) {
    saltCache = { username, salt };
  }
}

/**
 * The current session user's KDF salt. Returns undefined when it cannot be
 * fetched (logged out, offline, or a legacy account with no salt yet), in which
 * case the caller derives the original unsalted keys. Only the session user's
 * own salt is ever served, which is the whole point (F-01).
 */
export async function fetchKdfSalt(username: string): Promise<string | undefined> {
  if (saltCache && saltCache.username === username) return saltCache.salt;
  try {
    const res = await fetch("/api/auth/kdf-salt", { headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => null)) as { salt?: string } | null;
    if (data && typeof data.salt === "string" && data.salt.length > 0) {
      saltCache = { username, salt: data.salt };
      return data.salt;
    }
  } catch {
    // No salt this tab: fall back to the unsalted derivation.
  }
  return undefined;
}

export type UnlockedKeys = {
  username: string;
  publicKey: string;
  secretKey: Uint8Array;
  /**
   * The account's Ed25519 SIGNING keypair, derived alongside the X25519
   * encryption pair (lib/e2ee.ts). Optional so an entry written by a tab that
   * predates signing keys still loads: consumers that need to sign (the deal
   * page's receipt attestation, the exchange stepper) re-derive from the
   * password when these are absent. signingPublicKey is base64url.
   */
  signingPublicKey?: string;
  signingSecretKey?: Uint8Array;
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // storage disabled; the UI falls back to locked states
  }
}

/** The unlocked keys for exactly this user, or null. Never throws. */
export function loadKeys(username: string): UnlockedKeys | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      username?: string;
      publicKey?: string;
      secretKey?: string;
      signingPublicKey?: string;
      signingSecretKey?: string;
    };
    if (parsed.username !== username) return null;
    const secretKey = fromB64url(String(parsed.secretKey ?? ""));
    if (!secretKey || secretKey.length !== 32 || !parsed.publicKey) return null;
    const signingSecretKey = fromB64url(String(parsed.signingSecretKey ?? ""));
    const signingOk =
      typeof parsed.signingPublicKey === "string" &&
      signingSecretKey &&
      signingSecretKey.length === 32;
    return {
      username,
      publicKey: String(parsed.publicKey),
      secretKey,
      ...(signingOk
        ? {
            signingPublicKey: parsed.signingPublicKey,
            signingSecretKey: signingSecretKey!,
          }
        : {}),
    };
  } catch {
    return null;
  }
}

export function saveKeys(keys: UnlockedKeys): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({
        username: keys.username,
        publicKey: keys.publicKey,
        secretKey: toB64url(keys.secretKey),
        ...(keys.signingPublicKey && keys.signingSecretKey
          ? {
              signingPublicKey: keys.signingPublicKey,
              signingSecretKey: toB64url(keys.signingSecretKey),
            }
          : {}),
      }),
    );
  } catch {
    // Quota or privacy mode: the tab just stays locked. Nothing to do.
  }
}

export function clearKeys(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Already gone or inaccessible either way.
  }
}

/**
 * Derive-and-store, shared by the login form, the signup flow and the
 * in-thread unlock panel. When `expectedPubkey` is given (the server holds
 * a registered key), a mismatch means the password was wrong for THIS
 * derivation, and nothing is stored.
 */
export async function unlockWithPassword(
  username: string,
  password: string,
  expectedPubkey?: string | null,
): Promise<UnlockedKeys | null> {
  // The identity keys are derived under this account's per-user KDF salt, so
  // the derived public key matches the one login registered (F-01). Legacy
  // accounts with no salt row fall back to the unsalted derivation.
  const kdfSalt = await fetchKdfSalt(username);
  const derived = await deriveIdentityKeys(username, password, kdfSalt);
  if (expectedPubkey && derived.publicKey !== expectedPubkey) return null;
  // Split the signing pair off the same seed, so a tab unlocked for messages
  // can also sign a receipt or an exchange step without a second prompt or a
  // second scrypt. A failure here never blocks the unlock.
  const keys: UnlockedKeys = {
    username,
    publicKey: derived.publicKey,
    secretKey: derived.secretKey,
  };
  try {
    const signing = signingKeysFromSeed(derived.secretKey, username);
    keys.signingPublicKey = signing.publicKey;
    keys.signingSecretKey = signing.secretKey;
  } catch {
    // Messaging still works; signing re-derives on demand where it is needed.
  }
  saveKeys(keys);
  return keys;
}
