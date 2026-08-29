"use client";

import Link from "next/link";
import { useState } from "react";
import { deriveIdentityKeys, signingKeysFromSeed } from "@/lib/e2ee";
import { primeKdfSalt, saveKeys } from "@/components/messages/keystore";

/**
 * After the server accepts the password, the browser re-derives BOTH the E2EE
 * (X25519) and the SIGNING (Ed25519) keypair from it (lib/e2ee.ts) and keeps
 * the private halves in sessionStorage for this tab; nothing derived here is
 * ever sent. Accounts from before either key get their PUBLIC halves
 * registered on this login: the e2ee key upgrades future threads to
 * encrypted, the signing key lets the account party-sign receipts and exchange
 * steps. Both registrations are write-once server-side, so a differing stored
 * key is never overwritten; the client flags a mismatch instead.
 */
async function establishEncryptionKeys(
  username: string,
  password: string,
  kdfSalt?: string,
) {
  try {
    // The per-user KDF salt the login response just delivered (F-01): the keys
    // are derived under it, so the published public key is not a pure function
    // of (password, handle). Cached for this tab's later unlock/sign flows.
    primeKdfSalt(username, kdfSalt);
    const keys = await deriveIdentityKeys(username, password, kdfSalt);
    const res = await fetch("/api/e2ee/pubkey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey: keys.publicKey }),
    });
    const data = (await res.json().catch(() => ({}))) as { pubkey?: string };

    // The signing key, registered the same way. Split off the e2ee seed we just
    // computed (no second scrypt), and done after the e2ee key is settled so it
    // never delays the encryption-key registration the rest of the app awaits.
    let signingPublicKey: string | undefined;
    let signingSecretKey: Uint8Array | undefined;
    try {
      const signing = signingKeysFromSeed(keys.secretKey, username);
      await fetch("/api/signing/pubkey", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pubkey: signing.publicKey }),
      });
      signingPublicKey = signing.publicKey;
      signingSecretKey = signing.secretKey;
    } catch {
      // Signing re-derives on demand where it is needed; login stands.
    }

    saveKeys({
      username,
      publicKey: keys.publicKey,
      secretKey: keys.secretKey,
      signingPublicKey,
      signingSecretKey,
    });
    if (res.ok && data.pubkey && data.pubkey !== keys.publicKey) {
      console.warn(
        "e2ee: the registered public key differs from the derived one; encrypted threads will flag this",
      );
    }
  } catch {
    // No keys this tab, threads show their locked state. Signing in again
    // retries; the account itself is unaffected.
  }
}

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sign in failed.");
      await establishEncryptionKeys(username.trim().toLowerCase(), password, data.kdfSalt);
      // Hard navigation: a session just began, so every cached RSC payload is
      // stale. router.refresh() + push() race each other here (the push can
      // win and render the board logged-out from the router cache).
      window.location.assign("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[440px] px-5 py-16">
      <h1 className="bt-display text-[2rem] leading-[1.1] text-ink">Sign in</h1>
      <p className="mt-3 text-[0.875rem] leading-relaxed text-ink-dim">
        Handle and password. There is no reset flow, because we keep no
        address to send one to.
      </p>

      <form onSubmit={submit} className="mt-7 space-y-4">
        <label className="block">
          <span className="bt-label">Handle</span>
          <input
            className="bt-input mt-2 font-mono"
            autoFocus
            autoComplete="username"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
          />
        </label>

        <label className="block">
          <span className="bt-label">Password</span>
          <input
            className="bt-input mt-2 font-mono"
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error ? (
          <p className="border-l-2 border-red bg-red-wash px-3 py-2 text-[0.8125rem] text-ink">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="bt-btn bt-btn-primary w-full"
        >
          {busy ? "Checking" : "Sign in"}
        </button>
      </form>

      <p className="mt-8 border-t border-rule pt-5 text-[0.8125rem] text-ink-faint">
        No account?{" "}
        <Link href="/signup" className="text-blue hover:text-amber">
          Get one
        </Link>
        . Forgot your password? Then the account is gone. That is the price of
        a database that cannot identify you.
      </p>
    </div>
  );
}
