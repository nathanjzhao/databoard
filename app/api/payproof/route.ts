/**
 * GET /api/payproof
 *
 * The status of the verifiable proof-of-payment rung (fiat ladder F2). No
 * secrets: whether a verifier is configured, which mode, the pinned provider
 * version when there is one, and the predicate a proof must satisfy. The UI note
 * in the exchange panel reads this to say "planned", "demo", or "active" without
 * guessing, and /transparency/verification cites the same predicate.
 *
 * Inert by default: with nothing configured this reports mode "unconfigured",
 * and POST /api/payproof/verify answers 503. See lib/payproof.ts and
 * docs/SETTLEMENT.md.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { payProofStatus } from "@/lib/payproof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json({ status: payProofStatus() });
}
