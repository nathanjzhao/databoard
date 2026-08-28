/**
 * POST /api/payproof/verify
 *
 * The verifiable proof-of-payment SEAM (fiat ladder F2). It is inert until a
 * verifier is configured, mirroring the OTP provider pattern in lib/verify.ts:
 * a Boolean(env) feature check, a 503 when unconfigured, and a clearly-labeled
 * demo transport for dev only. Nothing here fakes a bank event.
 *
 * The real F2 flow keeps the proof off the server entirely: the seller produces
 * a zkTLS web proof against their bank, it travels E2EE to the buyer, and the
 * buyer VERIFIES IT IN THEIR OWN BROWSER. This route is what the buyer's browser
 * calls afterward to record only a salted HASH of the proof and the buyer's
 * acceptance, plus the normalized bucketed result, and to re-check the predicate
 * server-side. The server never receives the proof envelope's secrets, the bank
 * credentials, the account number, or the exact amount.
 *
 * Modes (lib/payproof.ts):
 *   unconfigured -> 503, "planned". Nothing is wired.
 *   reclaim      -> 503, "not implemented". The provider is pinned but the
 *                   browser verifier is not shipped; we refuse rather than fake.
 *   demo         -> 200 with a demo result and record, every field flagged demo,
 *                   the predicate reported honestly (a demo carries no terminal
 *                   bank status, so predicate.ok is false and says so).
 *
 * Body: {
 *   dealId, expectedN15, expectedAmountBucket, expectedRail,
 *   sessionOpenedAt, sellerAccountNullifier,
 *   envelope: PayProofEnvelope, proofHash, accepted
 * }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  checkPredicate,
  getPayProofVerifier,
  payProofStatus,
  toPayProofRecord,
  type PayProofContext,
  type PayProofEnvelope,
} from "@/lib/payproof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VerifyBody = {
  dealId?: string;
  expectedN15?: string;
  expectedAmountBucket?: string;
  expectedRail?: string;
  sessionOpenedAt?: number;
  sellerAccountNullifier?: string | null;
  envelope?: PayProofEnvelope;
  proofHash?: string;
  accepted?: boolean;
};

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const status = payProofStatus();
  if (!status.configured) {
    return NextResponse.json(
      {
        error: "Verifiable proof-of-payment is planned; no verifier is configured.",
        status,
      },
      { status: 503 },
    );
  }

  let body: VerifyBody;
  try {
    body = (await request.json()) as VerifyBody;
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.dealId !== "string" ||
    typeof body.expectedN15 !== "string" ||
    typeof body.expectedAmountBucket !== "string" ||
    typeof body.expectedRail !== "string" ||
    typeof body.proofHash !== "string" ||
    !body.envelope
  ) {
    return NextResponse.json(
      { error: "Expected a proof envelope and the deal's expectations." },
      { status: 400 },
    );
  }

  const verifier = getPayProofVerifier();
  if (!verifier) {
    // configured but no verifier: the throw-guarded demo-in-production case.
    return NextResponse.json(
      { error: "Verifiable proof-of-payment is not available here.", status },
      { status: 503 },
    );
  }

  const ctx: PayProofContext = {
    dealId: body.dealId,
    expectedN15: body.expectedN15,
    expectedAmountBucket: body.expectedAmountBucket,
    expectedRail: body.expectedRail,
    sessionOpenedAt: typeof body.sessionOpenedAt === "number" ? body.sessionOpenedAt : Date.now(),
    sellerAccountNullifier:
      typeof body.sellerAccountNullifier === "string" ? body.sellerAccountNullifier : null,
  };

  const verified = await verifier.verify(body.envelope, ctx);
  if (!verified.ok) {
    // not_implemented is the honest reclaim placeholder: the provider is pinned
    // but the browser verifier is not shipped, so we answer 503 rather than fake
    // a pass. Everything else is a client/proof error.
    if (verified.reason === "not_implemented") {
      return NextResponse.json(
        {
          error: "Verifiable proof-of-payment verifier is configured but not yet implemented.",
          status,
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: `Proof rejected: ${verified.reason}.` }, { status: 422 });
  }

  const predicate = checkPredicate(verified.result, ctx);
  const record = toPayProofRecord(body.proofHash, verified.result, body.accepted === true);

  return NextResponse.json({
    mode: status.mode,
    result: verified.result,
    predicate,
    record,
    note:
      status.mode === "demo"
        ? "Demo proof. It asserts nothing about real money and carries no terminal bank status; a real proof would satisfy the terminal-status clause the predicate lists."
        : undefined,
  });
}
