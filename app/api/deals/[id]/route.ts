/**
 * POST /api/deals/[id]
 *
 * The three things a named participant can do to their own row, and only
 * their own row:
 *
 *   { action: "confirm" }                         pending -> confirmed
 *   { action: "decline" }                         pending -> declined, final
 *   { action: "evidence", hash, label }           store an evidence commitment
 *
 * Authorization lives in lib/deals.ts: a deal the caller is not on answers
 * not_found, indistinguishable from a deal that does not exist. The evidence
 * hash was computed in the caller's browser; the server only ever sees the
 * 64 hex characters and the label.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import {
  commitEvidence,
  confirmDealShare,
  declineDealShare,
} from "@/lib/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  action?: string;
  hash?: string;
  label?: string;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { id } = await params;
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "confirm":
      case "decline": {
        const act = body.action === "confirm" ? confirmDealShare : declineDealShare;
        const result = await act(id, user.id);
        if (!result.ok) {
          const status = result.error === "not_found" ? 404 : 409;
          const message =
            result.error === "not_found"
              ? "No such deal."
              : "Your row on this deal is already settled.";
          return NextResponse.json({ error: message }, { status });
        }
        return NextResponse.json({ status: result.status, tier: result.tier });
      }
      case "evidence": {
        const result = await commitEvidence(
          id,
          user.id,
          String(body.hash ?? ""),
          String(body.label ?? ""),
        );
        if (!result.ok) {
          const map = {
            not_found: { status: 404, message: "No such deal." },
            not_confirmed: {
              status: 409,
              message: "Confirm your share first; evidence rides on a confirmed row.",
            },
            bad_hash: {
              status: 400,
              message: "That is not a SHA-256. Expected 64 hex characters.",
            },
            bad_label: {
              status: 400,
              message: "Give the evidence a short label, 80 characters max.",
            },
            already_committed: {
              status: 409,
              message: "A hash is already committed on your row. Commitments do not rotate.",
            },
          } as const;
          const { status, message } = map[result.error];
          return NextResponse.json({ error: message }, { status });
        }
        return NextResponse.json({ tier: result.tier });
      }
      default:
        return NextResponse.json(
          { error: "action must be confirm, decline or evidence." },
          { status: 400 },
        );
    }
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
