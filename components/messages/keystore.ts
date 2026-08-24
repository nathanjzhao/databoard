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

import { deriveIdentityKeys, fromB64url, toB64url } from "@/lib/e2ee";

const STORAGE_KEY = "databoard.e2ee.v1";

export type UnlockedKeys = {
  username: string;
  publicKey: string;
  secretKey: Uint8Array;
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
    };
    if (parsed.username !== username) return null;
    const secretKey = fromB64url(String(parsed.secretKey ?? ""));
    if (!secretKey || secretKey.length !== 32 || !parsed.publicKey) return null;
    return { username, publicKey: String(parsed.publicKey), secretKey };
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
  const derived = await deriveIdentityKeys(username, password);
  if (expectedPubkey && derived.publicKey !== expectedPubkey) return null;
  const keys: UnlockedKeys = {
    username,
    publicKey: derived.publicKey,
    secretKey: derived.secretKey,
  };
  saveKeys(keys);
  return keys;
}
