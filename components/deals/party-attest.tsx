"use client";

/**
 * components/deals/party-attest.tsx
 *
 * The party-signature panel on an attested deal page. It shows which confirmed
 * participants have signed the receipt with their OWN key, verifies each stored
 * signature in the browser (so the check does not trust the server that served
 * it), and lets the viewer add their own signature.
 *
 * Signing is one click when this tab is already unlocked (the signing key sits
 * in sessionStorage from login); a fresh tab is asked for the password, which
 * re-derives the key locally. Nothing secret is ever sent: the browser computes
 * the canonical receipt bytes, signs them, and posts only the public key and
 * the signature.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchKdfSalt, loadKeys } from "@/components/messages/keystore";
import { deriveSigningKeys } from "@/lib/e2ee";
import {
  partySigningBase,
  signReceiptBase,
  verifyAttestation,
  type PartyBaseFields,
  type ReceiptPartySig,
} from "@/lib/receipt-attest";

type SignState =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "need_password" }
  | { kind: "error"; message: string }
  | { kind: "done" };

export function PartyAttest({
  dealId,
  viewerHandle,
  viewerInRoster,
  viewerConfirmed,
  fields,
  sigs,
}: {
  dealId: string;
  viewerHandle: string;
  /** Whether the viewer is on the signer roster (confirmed AND holds a signing key). */
  viewerInRoster: boolean;
  /** Whether the viewer is a confirmed participant at all. */
  viewerConfirmed: boolean;
  fields: PartyBaseFields;
  sigs: ReceiptPartySig[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SignState>({ kind: "idle" });
  const [password, setPassword] = useState("");

  // Verify every stored signature here, in the browser, over the recomputed
  // canonical base. The server's word is not trusted for this.
  const verification = useMemo(() => verifyAttestation(fields, sigs), [fields, sigs]);
  const validSet = useMemo(() => new Set(verification.valid), [verification.valid]);

  const viewerSigned = validSet.has(viewerHandle);
  const total = fields.signers.length;
  const signed = verification.valid.length;

  async function submitSignature(secretKey: Uint8Array, pubkey: string) {
    const base = partySigningBase(fields);
    const sig = signReceiptBase(base, secretKey);
    const res = await fetch(`/api/deals/${dealId}/receipt-sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, sig }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "Could not record the signature.");
    }
  }

  async function signFromKeystore() {
    setState({ kind: "signing" });
    const keys = loadKeys(viewerHandle);
    if (!keys?.signingSecretKey || !keys.signingPublicKey) {
      // Locked tab: fall back to the password to re-derive the signing key.
      setState({ kind: "need_password" });
      return;
    }
    try {
      await submitSignature(keys.signingSecretKey, keys.signingPublicKey);
      setState({ kind: "done" });
      router.refresh();
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }

  async function signFromPassword(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "signing" });
    try {
      // Under this account's per-user KDF salt (F-01), so the derived key is the
      // registered one; a legacy account with no salt derives unsalted.
      const kdfSalt = await fetchKdfSalt(viewerHandle);
      const signing = await deriveSigningKeys(viewerHandle, password, kdfSalt);
      setPassword("");
      await submitSignature(signing.secretKey, signing.publicKey);
      setState({ kind: "done" });
      router.refresh();
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }

  return (
    <div className="border border-rule bg-panel px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="bt-label">Party signatures</div>
        <span className="font-mono text-[0.6875rem] text-ink-faint">
          {signed} of {total} signed
        </span>
      </div>

      <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-dim">
        Each confirmed participant can sign this receipt with their own key, so a
        valid co-attested receipt proves the parties themselves attested, not
        just that the platform vouches for it. The platform holds no party key,
        so it cannot forge these.{" "}
        {verification.allSigned ? (
          <span className="text-green">Every party has signed.</span>
        ) : (
          <span className="text-ink-faint">
            Signatures are checked in your browser against each party&apos;s
            registered key.
          </span>
        )}
      </p>

      <ul className="mt-3.5 divide-y divide-rule border-t border-rule">
        {fields.signers.map((s) => {
          const isValid = validSet.has(s.handle);
          const isYou = s.handle === viewerHandle;
          return (
            <li
              key={s.handle}
              className="flex items-center justify-between gap-4 py-2"
            >
              <span className="font-mono text-[0.8125rem] text-ink">
                @{s.handle}
                {isYou ? <span className="text-ink-faint"> (you)</span> : null}
              </span>
              <span
                className={[
                  "font-mono text-[0.6875rem] uppercase tracking-[0.12em]",
                  isValid ? "text-green" : "text-ink-faint",
                ].join(" ")}
              >
                {isValid ? "signed" : "not yet"}
              </span>
            </li>
          );
        })}
      </ul>

      {viewerConfirmed && !viewerInRoster ? (
        <p className="mt-3 border-l-2 border-amber bg-amber-wash px-3 py-2 text-[0.75rem] leading-relaxed text-ink-dim">
          Your signing key is not registered yet. Sign in again to register it,
          then you can add your signature here.
        </p>
      ) : null}

      {viewerInRoster && !viewerSigned && state.kind !== "done" ? (
        <div className="mt-4">
          {state.kind === "need_password" ? (
            <form onSubmit={signFromPassword} className="space-y-2">
              <p className="text-[0.75rem] leading-relaxed text-ink-faint">
                This tab is locked. Your password re-derives the signing key
                here; it is never sent.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="bt-input font-mono text-[0.8125rem]"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={password.length === 0}
                  className="bt-btn bt-btn-primary px-3 py-1.5 text-[0.75rem]"
                >
                  Sign
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={signFromKeystore}
              disabled={state.kind === "signing"}
              className="bt-btn bt-btn-primary px-3 py-1.5 text-[0.75rem]"
            >
              {state.kind === "signing" ? "Signing…" : "Sign this receipt with your key"}
            </button>
          )}
          {state.kind === "error" ? (
            <p className="mt-2 border-l-2 border-red bg-red-wash px-3 py-2 text-[0.75rem] text-ink">
              {state.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {viewerSigned || state.kind === "done" ? (
        <p className="mt-3 text-[0.75rem] text-green">
          You have signed this receipt.
        </p>
      ) : null}
    </div>
  );
}
