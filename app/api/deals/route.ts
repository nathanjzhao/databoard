/**
 * POST /api/deals
 *
 * Body:  { buyerTokenV2, buyerIsOther, askId?, totalUsd, myShareUsd, note?,
 *          participants: [{ username, shareUsd }] }
 * Reply: { id, threadId }
 *
 * Same contract as POST /api/asks: no buyer name crosses the wire in any
 * form. The browser blinds the name, /api/voprf/evaluate computes the token
 * without seeing it, the browser verifies the proof and submits only the
 * finished "v2:" token (lib/voprf.ts). A request still carrying a `buyer`
 * field is rejected outright. The dollar figures are the opposite: stored
 * exactly as sent, in the clear, which the form says out loud and the
 * transparency page repeats.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { settlementStanding } from "@/lib/referrals";
import { DbNotConfiguredError } from "@/lib/db";
import { isBuyerTokenV2 } from "@/lib/voprf";
import {
  MAX_DEAL_PARTICIPANTS,
  createDeal,
  type CreateDealResult,
} from "@/lib/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  buyerTokenV2?: string;
  buyerIsOther?: boolean;
  askId?: string | null;
  totalUsd?: number;
  myShareUsd?: number;
  note?: string;
  participants?: { username?: string; shareUsd?: number }[];
};

const ERROR_COPY: Record<Extract<CreateDealResult, { ok: false }>["error"], string> = {
  bad_total: "Total must be a whole dollar amount above zero.",
  bad_share: "Every share must be a whole dollar amount, zero or more.",
  too_many_participants: `At most ${MAX_DEAL_PARTICIPANTS} named participants.`,
  duplicate_participant: "The same username appears twice in the split.",
  self_participant: "You are the reporter; your share has its own field.",
  unknown_username: "One of those usernames has no account.",
  shares_exceed_total: "The shares sum past the total. The ledger will not take that.",
  bad_ask: "That linked ask does not exist.",
  note_too_long: "Note: 2000 characters max.",
};

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Referral standing gate, same rule as posting an ask: more than 60 days
  // behind on referral obligations blocks recording new deals until the
  // account settles or disputes. Privilege-gating, never money movement.
  try {
    const standing = await settlementStanding(user.id);
    if (standing.behind) {
      return NextResponse.json(
        {
          error:
            "This account is behind on referral obligations. Settle or dispute them on the invites page first.",
        },
        { status: 403 },
      );
    }
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  if ("buyer" in body) {
    // A raw name showing up at all means an out-of-date or hostile client.
    return NextResponse.json(
      { error: "This API no longer accepts a buyer name in any form. Send the blinded token." },
      { status: 400 },
    );
  }
  const token = body.buyerTokenV2 ?? "";
  if (!isBuyerTokenV2(token)) {
    return NextResponse.json(
      { error: "Missing or malformed blinded buyer token." },
      { status: 400 },
    );
  }
  if (typeof body.buyerIsOther !== "boolean") {
    return NextResponse.json(
      { error: "Say whether the buyer was off-list." },
      { status: 400 },
    );
  }
  const buyerIsOther = body.buyerIsOther;

  const rawParticipants = Array.isArray(body.participants) ? body.participants : [];
  const participants = rawParticipants.map((p) => ({
    username: String(p?.username ?? ""),
    shareUsd: Number(p?.shareUsd),
  }));

  try {
    const result = await createDeal(user.id, user.username, {
      buyerToken: token,
      buyerIsOther,
      askId: typeof body.askId === "string" && body.askId.length > 0 ? body.askId : null,
      totalUsd: Number(body.totalUsd),
      myShareUsd: Number(body.myShareUsd),
      note: String(body.note ?? ""),
      participants,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.detail ?? ERROR_COPY[result.error] },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { id: result.dealId, threadId: result.threadId },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
