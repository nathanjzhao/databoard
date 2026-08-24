"use client";

/**
 * Signup, four screens:
 *   identity (name + affiliation + contact)  ->  code  ->  credentials  ->  done
 *
 * Name, affiliation and contact never leave this component except as the body
 * of two fetches, and the server does not write any of them down: they are
 * bound into a keyed challenge that round-trips through this browser. See
 * lib/verify.ts. The only durable output is username, a password hash, an
 * org-or-individual bit, and a blind index of the contact.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { INDEPENDENT_AFFILIATION } from "@/lib/taxonomy";
import { deriveIdentityKeys } from "@/lib/e2ee";
import { saveKeys } from "@/components/messages/keystore";

type Step = "identity" | "code" | "credentials" | "done";

type Issued = {
  challenge: string;
  expiresAt: number;
  contactKind: "email" | "phone";
  demo: boolean;
  demoCode?: string;
  blurb: string;
};

const STEP_ORDER: Step[] = ["identity", "code", "credentials", "done"];
const STEP_TITLE: Record<Step, string> = {
  identity: "Say who you are, once",
  code: "Type the code back",
  credentials: "Pick what we actually keep",
  done: "That is everything",
};

export function SignupFlow() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("identity");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [realName, setRealName] = useState("");
  const [independent, setIndependent] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [contact, setContact] = useState("");

  const [issued, setIssued] = useState<Issued | null>(null);
  const [code, setCode] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [finalUsername, setFinalUsername] = useState("");

  const affiliation = independent ? INDEPENDENT_AFFILIATION : orgName;

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/request-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact, realName, affiliation }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not send a code.");
      setIssued(data as Issued);
      setCode(data.demoCode ?? "");
      setStep("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (code.replace(/\D/g, "").length !== 6) {
      setError("Six digits.");
      return;
    }
    setStep("credentials");
  }

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!issued) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/verify-and-signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact,
          realName,
          affiliation,
          code,
          challenge: issued.challenge,
          username,
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Signup failed.");
      setFinalUsername(data.username);
      // End-to-end encryption setup, before the password leaves memory: the
      // browser derives an X25519 keypair from it (lib/e2ee.ts), registers
      // the PUBLIC half, and keeps the private half in sessionStorage for
      // this tab. The password and the private key are never sent.
      try {
        const keys = await deriveIdentityKeys(String(data.username), password);
        await fetch("/api/e2ee/pubkey", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pubkey: keys.publicKey }),
        });
        saveKeys({
          username: String(data.username),
          publicKey: keys.publicKey,
          secretKey: keys.secretKey,
        });
      } catch {
        // Registration retries on the next login; signup itself stands.
      }
      // Nothing below survives on the server; drop it here too.
      setContact("");
      setRealName("");
      setOrgName("");
      setPassword("");
      setStep("done");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[560px] px-5 py-14">
      <StepRail step={step} />

      <h1 className="bt-display mt-6 text-[2rem] leading-[1.1] text-ink">
        {STEP_TITLE[step]}
      </h1>

      {step === "identity" ? (
        <>
          <p className="mt-3 max-w-[52ch] text-[0.875rem] leading-relaxed text-ink-dim">
            Vetting needs a real name, an affiliation, and one working contact.
            None of the three is stored. They are folded into a keyed hash that
            travels through your browser and back, which proves they were what
            you said when the code went out, and then they are gone. What the
            database keeps is on the next screens.
          </p>
          <form onSubmit={requestCode} className="mt-7 space-y-4">
            <label className="block">
              <span className="bt-label">Real name</span>
              <input
                className="bt-input mt-2"
                autoFocus
                autoComplete="name"
                placeholder="Ada Lovelace"
                value={realName}
                onChange={(e) => setRealName(e.target.value)}
              />
            </label>

            <div>
              <span className="bt-label">Affiliation</span>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setIndependent(false)}
                  className={[
                    "border px-3 py-2 text-left text-[0.8125rem] transition-colors",
                    !independent
                      ? "border-ink bg-ink text-void"
                      : "border-rule-strong bg-panel-2 text-ink-faint hover:text-ink-dim",
                  ].join(" ")}
                >
                  An organization
                </button>
                <button
                  type="button"
                  onClick={() => setIndependent(true)}
                  className={[
                    "border px-3 py-2 text-left text-[0.8125rem] transition-colors",
                    independent
                      ? "border-ink bg-ink text-void"
                      : "border-rule-strong bg-panel-2 text-ink-faint hover:text-ink-dim",
                  ].join(" ")}
                >
                  Independent individual
                </button>
              </div>
              {!independent ? (
                <input
                  className="bt-input mt-2"
                  autoComplete="organization"
                  placeholder="Org name"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                />
              ) : (
                <p className="mt-2 text-[0.75rem] text-ink-faint">
                  Recorded as one bit: individual. Nothing more.
                </p>
              )}
            </div>

            <label className="block">
              <span className="bt-label">Phone or email</span>
              <input
                className="bt-input mt-2"
                autoComplete="off"
                placeholder="+1 415 555 0142  or  you@lab.org"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
              <p className="mt-2 text-[0.75rem] text-ink-faint">
                One account per contact, enforced by a blind index, which is the
                one trace of it that persists. No recovery goes through it,
                nothing is ever sent to it after this code.
              </p>
            </label>

            <ErrorLine error={error} />
            <button
              type="submit"
              disabled={
                busy ||
                realName.trim().length < 2 ||
                contact.trim().length < 5 ||
                (!independent && orgName.trim().length < 2)
              }
              className="bt-btn bt-btn-primary w-full"
            >
              {busy ? "Working" : "Send me a code"}
            </button>
          </form>
        </>
      ) : null}

      {step === "code" && issued ? (
        <>
          <p className="mt-3 text-[0.875rem] leading-relaxed text-ink-dim">
            {issued.blurb}
          </p>

          {issued.demo && issued.demoCode ? (
            <div className="mt-5 border border-amber-soft bg-amber-wash px-4 py-3">
              <div className="bt-label text-amber">Demo mode</div>
              <div className="mt-2 font-mono text-[1.5rem] tracking-[0.35em] text-amber">
                {issued.demoCode}
              </div>
              <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-dim">
                A real deployment sends this over SMS or email and never shows
                it here. It is on screen because there is no delivery provider
                wired up in the demo.
              </p>
            </div>
          ) : null}

          <form onSubmit={submitCode} className="mt-6 space-y-3">
            <label className="block">
              <span className="bt-label">Six digit code</span>
              <input
                className="bt-input mt-2 font-mono tracking-[0.3em]"
                inputMode="numeric"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <ErrorLine error={error} />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setStep("identity");
                  setError(null);
                }}
                className="bt-btn"
              >
                Back
              </button>
              <button type="submit" className="bt-btn bt-btn-primary flex-1">
                Continue
              </button>
            </div>
          </form>
        </>
      ) : null}

      {step === "credentials" ? (
        <>
          <p className="mt-3 max-w-[52ch] text-[0.875rem] leading-relaxed text-ink-dim">
            From everything you typed so far, the database will hold exactly
            four things: this username, a hash of this password, whether you
            are an org or an individual, and a blind index of your contact.
            The username is the only one anybody sees.
          </p>
          <form onSubmit={submitCredentials} className="mt-7 space-y-4">
            <label className="block">
              <span className="bt-label">Username</span>
              <input
                className="bt-input mt-2 font-mono"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="quiet_ledger"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
              />
              <p className="mt-2 text-[0.75rem] text-ink-faint">
                3 to 24 characters. Lowercase letters, numbers, dashes,
                underscores. Pick something that does not point back at you.
              </p>
            </label>

            <label className="block">
              <span className="bt-label">Password</span>
              <input
                className="bt-input mt-2 font-mono"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="mt-2 text-[0.75rem] text-ink-faint">
                At least 10 characters. There is no reset: we keep no contact to
                send one to. Lose it and the account is gone. Write it down now.
              </p>
            </label>

            <ErrorLine error={error} />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setStep("code");
                  setError(null);
                }}
                className="bt-btn"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={busy || username.trim().length < 3 || password.length < 10}
                className="bt-btn bt-btn-primary flex-1"
              >
                {busy ? "Creating" : "Create account"}
              </button>
            </div>
          </form>
        </>
      ) : null}

      {step === "done" ? (
        <>
          <p className="mt-3 max-w-[52ch] text-[0.875rem] leading-relaxed text-ink-dim">
            You are signed in as{" "}
            <span className="font-mono text-ink">@{finalUsername}</span>. Your
            name, your org and your contact were checked, attested and
            discarded. If that sounds like a claim rather than a fact, the
            transparency page shows the entire schema so you can look for the
            columns they would need to live in.
          </p>

          <div className="mt-6 flex gap-2">
            <Link href="/" className="bt-btn bt-btn-primary">
              Go to the board
            </Link>
            <Link href="/transparency" className="bt-btn">
              Read the schema
            </Link>
          </div>

          <p className="mt-4 text-[0.75rem] leading-relaxed text-ink-faint">
            One more time, because it is unusual: there is no password reset and
            no support inbox that can look you up. Nothing stored can identify
            you, which also means nothing stored can rescue you.
          </p>
        </>
      ) : null}

      {step !== "done" ? (
        <p className="mt-8 border-t border-rule pt-5 text-[0.8125rem] text-ink-faint">
          Already have an account?{" "}
          <Link href="/login" className="text-blue hover:text-amber">
            Sign in
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function StepRail({ step }: { step: Step }) {
  const idx = STEP_ORDER.indexOf(step);
  return (
    <div className="flex items-center gap-2">
      {STEP_ORDER.map((s, i) => (
        <div key={s} className="flex flex-1 items-center gap-2">
          <span
            className={[
              "h-px flex-1",
              i <= idx ? "bg-amber" : "bg-ink-ghost",
            ].join(" ")}
          />
          <span
            className={[
              "bt-label",
              i === idx ? "text-amber" : i < idx ? "text-ink-faint" : "text-ink-ghost",
            ].join(" ")}
          >
            {String(i + 1).padStart(2, "0")}
          </span>
        </div>
      ))}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="border-l-2 border-red bg-red-wash px-3 py-2 text-[0.8125rem] text-ink">
      {error}
    </p>
  );
}
