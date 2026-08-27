/**
 * /receipts/verify
 *
 * Publicly reachable, like /transparency: a portable receipt is worthless if a
 * counterparty needs an account to check it. Paste a token, get valid/invalid
 * and the fields it attests. Verification is a pure HMAC recompute against this
 * instance's pepper (lib/receipts.ts); nothing is read from or written to the
 * database, and no session is required (lib/gate.ts serves this path).
 *
 * A ?token= query param prefills and auto-verifies, so a shared receipt link
 * checks itself on open.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { ReceiptVerifier } from "@/components/deals/receipt-verifier";

export const metadata: Metadata = {
  title: "Verify a receipt",
  description:
    "Paste a DataBoard deal receipt and confirm it is genuine and unaltered. No account needed.",
};
export const dynamic = "force-dynamic";

export default async function VerifyReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  const initialToken = typeof sp.token === "string" ? sp.token : "";

  return (
    <div className="mx-auto w-full max-w-[860px] px-5 py-14">
      <div className="bt-label">Receipts</div>
      <h1 className="bt-display mt-3 text-[2.5rem] leading-[1.05] text-ink">
        Check a receipt.
      </h1>
      <p className="mt-4 max-w-[64ch] text-[0.9375rem] leading-relaxed text-ink-dim">
        A DataBoard receipt is a compact, platform-signed token minted from an
        attested deal. Paste one below to confirm it is genuine and nothing in it
        was changed. This page is public and reads no database; the check is a
        signature recompute in memory.
      </p>

      <div className="mt-8">
        <ReceiptVerifier initialToken={initialToken} />
      </div>

      <div className="mt-10 border-t border-rule pt-6">
        <div className="bt-label">What a valid result means</div>
        <p className="mt-2 max-w-[64ch] text-[0.8125rem] leading-relaxed text-ink-faint">
          Receipts are signed with a shared secret the platform holds, not a
          public key, so the platform can forge its own. A valid receipt proves
          DataBoard vouches the deal was recorded here, at the tier and bucket
          shown, between the handles shown. It is the same operator-attested
          trust tier as the rest of the board, stated in full on{" "}
          <Link
            href="/transparency/verification#receipts"
            className="text-blue hover:text-amber"
          >
            the verification page
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
