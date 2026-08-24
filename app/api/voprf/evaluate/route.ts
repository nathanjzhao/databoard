/**
 * POST /api/voprf/evaluate
 *
 * Body:  { evalReq: "<hex of one serialized RFC 9497 EvaluationRequest>" }
 * Reply: { evaluation: "<hex of the serialized Evaluation, DLEQ proof included>",
 *          publicKey: "<hex>" }
 *
 * The only thing that ever arrives here is a blinded ristretto255 point:
 * uniformly random bytes from the server's perspective, whatever the name
 * behind them was. There is no code path in this handler that could log,
 * store, or recognize a buyer, because the material to do so never exists
 * on this side. The reply's DLEQ proof is what stops us from cheating in
 * the other direction: an evaluation under any key but the published one
 * fails the client's verify and is thrown away.
 *
 * Auth required: blind evaluation is a member capability, not a public
 * oracle, and the rate limit below is the only thing that makes offline
 * dictionary probing by OTHER MEMBERS slow. (The operator needs no oracle;
 * they hold the key. /transparency says so.)
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { RATE_LIMITS, checkRateLimit, retryPhrase } from "@/lib/ratelimit";
import {
  BadEvaluationRequestError,
  evaluateBlindedBuyer,
} from "../server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ----------------------------------------------------------------- route */

type Body = { evalReq?: string };

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // 30 evaluations per minute per user, counted in the shared rate_limits
  // table (lib/ratelimit.ts), so the ceiling holds across serverless
  // instances instead of multiplying by the number of warm containers. The
  // bucket is HMAC(pepper, scope|user id): the table gains counts, not a
  // request log. Still a throttle on casual probing, not a cryptographic
  // control; the operator holds the key and needs no oracle.
  const limited = await checkRateLimit(RATE_LIMITS.voprfPerUser, user.id);
  if (limited.limited) {
    return NextResponse.json(
      {
        error: `Too many blind evaluations. Wait ${retryPhrase(limited.retryAfterSeconds)}.`,
        retryAfterSeconds: limited.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(limited.retryAfterSeconds) },
      },
    );
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    const { evaluationHex, publicKeyHex } = await evaluateBlindedBuyer(
      body.evalReq ?? "",
    );
    return NextResponse.json({ evaluation: evaluationHex, publicKey: publicKeyHex });
  } catch (err) {
    if (err instanceof BadEvaluationRequestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
