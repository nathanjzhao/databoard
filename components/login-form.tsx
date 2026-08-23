"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const router = useRouter();
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
      router.refresh();
      router.push("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[440px] px-5 py-16">
      <h1 className="bt-display text-[2rem] leading-[1.1] text-ink">Sign in</h1>
      <p className="mt-3 text-[0.875rem] leading-relaxed text-ink-dim">
        Username and password. There is no reset flow, because we keep no
        address to send one to.
      </p>

      <form onSubmit={submit} className="mt-7 space-y-4">
        <label className="block">
          <span className="bt-label">Username</span>
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
