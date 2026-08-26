/**
 * POST /api/invites
 *
 * Mint one invite code for the signed-in member. Reply: { code }.
 *
 * The cap (at most 5 unused codes outstanding, operators uncapped) is
 * enforced in lib/invites.ts. Codes are server-generated randomness; there
 * is nothing to validate in the request body and none is read.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { MAX_UNUSED_INVITES, mintInvite } from "@/lib/invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  try {
    const minted = await mintInvite(user.id);
    if (!minted.ok) {
      return NextResponse.json(
        {
          error: `You already hold ${MAX_UNUSED_INVITES} unused codes. Spend one before minting another.`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ code: minted.code }, { status: 201 });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
