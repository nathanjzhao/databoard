/**
 * GET|POST /api/receipts/verify
 *
 * Public: anyone, with or without an account, can check a portable deal
 * receipt. No session, no database read; verification is a pure HMAC recompute
 * against this instance's SERVER_PEPPER (see lib/gate.ts, which serves this
 * exact path without a cookie). Both verbs answer identically:
 *
 *   GET  ?token=rcpt_v1.<body>.<sig>
 *   POST { "token": "rcpt_v1.<body>.<sig>" }
 *
 * A genuine, unaltered receipt returns { valid: true, receipt: {...fields} }.
 * Anything else returns { valid: false, reason } with a 200: a receipt failing
 * to verify is a normal, expected answer, not a server error. What "valid"
 * proves is stated honestly on /transparency/verification: the platform holds
 * the signing key, so this confirms DataBoard vouches the deal was recorded
 * here, not a third-party-unforgeable fact.
 */

import { NextResponse } from "next/server";
import { verifyReceipt, type VerifyReceiptResult } from "@/lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REASONS: Record<Exclude<VerifyReceiptResult, { ok: true }>["error"], string> = {
  malformed: "Not a receipt token, or the token is truncated.",
  unsupported_version: "This receipt uses a format this server does not know.",
  bad_signature: "Signature does not match. Altered, forged, or from another instance.",
};

function respond(token: string) {
  const result = verifyReceipt(token);
  if (result.ok) {
    return NextResponse.json(
      { valid: true, receipt: result.receipt },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { valid: false, reason: REASONS[result.error], error: result.error },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return respond(token);
}

export async function POST(request: Request) {
  let token = "";
  try {
    const body = (await request.json()) as { token?: unknown };
    token = typeof body.token === "string" ? body.token : "";
  } catch {
    return NextResponse.json(
      { valid: false, reason: "Expected JSON with a token field.", error: "malformed" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  return respond(token);
}
