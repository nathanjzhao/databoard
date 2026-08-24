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
import {
  BadEvaluationRequestError,
  evaluateBlindedBuyer,
} from "../server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------ rate limit */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;

/**
 * Sliding-window counter per user, in process memory. Honest caveat: on
 * serverless this is per-instance and resets on cold start, so the real
 * ceiling is MAX_PER_WINDOW times the number of warm instances. It is a
 * throttle on casual probing, not a cryptographic control; the schema keeps
 * no request log to enforce a stricter one with.
 */
const globalForRate = globalThis as unknown as {
  __dataBoardVoprfRate?: Map<string, number[]>;
};

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const map = (globalForRate.__dataBoardVoprfRate ??= new Map<string, number[]>());
  const kept = (map.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length >= MAX_PER_WINDOW) {
    map.set(userId, kept);
    return true;
  }
  kept.push(now);
  map.set(userId, kept);
  // Keep the map from accumulating every user id ever seen.
  if (map.size > 10_000) {
    for (const [k, v] of map) {
      if (v.every((t) => now - t >= WINDOW_MS)) map.delete(k);
    }
  }
  return false;
}

/* ----------------------------------------------------------------- route */

type Body = { evalReq?: string };

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: "Too many blind evaluations. Wait a minute." },
      { status: 429 },
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
