/**
 * /gate
 *
 * Where every logged-out request lands (see middleware.ts). The nav and
 * footer stay off this route (see site-nav.tsx): one wordmark, one line,
 * two doors in. /transparency carries the full argument.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Gate",
  description:
    "DataBoard is a vetted, pseudonymous board for data asks. The database keeps only your username.",
};
export const dynamic = "force-dynamic";

export default async function GatePage() {
  if (await getSessionUser()) redirect("/");

  return (
    <div className="mx-auto grid min-h-[100svh] w-full max-w-[1180px] content-center px-5 py-10">
      {/* wordmark */}
      <h1 className="bt-display text-[clamp(4rem,18.6vw,14.75rem)] leading-[0.93] tracking-[-0.045em] text-ink">
        DataBoard
      </h1>

      <div aria-hidden className="mt-[clamp(0.75rem,2.5vh,1.5rem)] h-[3px] bg-rule" />

      {/* one line, two doors */}
      <div className="mt-[clamp(1.25rem,3.5vh,2.25rem)] grid gap-x-8 gap-y-7 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center">
        <p className="text-[clamp(1.125rem,1.7vw,1.4375rem)] font-medium leading-snug tracking-[-0.01em] text-ink">
          A pseudonymous board for data asks. We keep only your username.{" "}
          <Link
            href="/transparency"
            className="font-normal text-ink-dim underline underline-offset-4 transition-colors hover:text-ink"
          >
            Audit us.
          </Link>
        </p>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <Link
            href="/signup"
            className="bt-btn bt-btn-primary px-6 py-3 text-[0.875rem]"
          >
            Request an account
          </Link>
          <Link href="/login" className="bt-btn px-6 py-3 text-[0.875rem]">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
