/**
 * POST /api/deals
 *
 * Body:  { buyer, askId?, totalUsd, myShareUsd, note?, participants: [{ username, shareUsd }] }
 * Reply: { id, threadId }
 *
 * The second of the two routes where a buyer name crosses the wire (the
 * first is POST /api/asks). It arrives in `buyer`, goes through buyerToken()
 * and is gone before the INSERT runs; never logged, never echoed back. The
 * dollar figures are the opposite: stored exactly as sent, in the clear,
 * which the form says out loud and the transparency page repeats.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { buyerToken } from "@/lib/crypto";
import { isKnownBuyer } from "@/lib/buyers";
import {
  MAX_DEAL_PARTICIPANTS,
  createDeal,
  type CreateDealResult,
} from "@/lib/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BUYER = 80;

type Body = {
  buyer?: string;
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

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const rawBuyer = (body.buyer ?? "").trim();
  if (rawBuyer.length === 0) {
    return NextResponse.json(
      { error: "Name the buyer. It is keyed and discarded, not stored." },
      { status: 400 },
    );
  }
  if (rawBuyer.length > MAX_BUYER) {
    return NextResponse.json(
      { error: `Buyer name: ${MAX_BUYER} characters max.` },
      { status: 400 },
    );
  }

  // The name -> token transform, and the last moment the name exists.
  let token: string;
  try {
    token = buyerToken(rawBuyer);
  } catch {
    return NextResponse.json(
      { error: "That buyer name is empty once normalized. Type a real one." },
      { status: 400 },
    );
  }
  const buyerIsOther = !isKnownBuyer(rawBuyer);

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
