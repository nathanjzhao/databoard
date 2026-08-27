/**
 * POST /api/invites
 *
 * Mint one invite code for the signed-in member. Reply: { code }.
 *
 * The cap (base 5 unused codes outstanding, raised by recorder standing, and
 * operators uncapped) is enforced in lib/invites.ts. Codes are server-generated
 * randomness; there is nothing to validate in the request body and none is read.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { mintInvite } from "@/lib/invites";
import { settlementStanding } from "@/lib/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  try {
    // Behind on referral obligations means no growing the tree either: the
    // same standing gate that blocks asks and deals blocks minting.
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
    const minted = await mintInvite(user.id);
    if (!minted.ok) {
      return NextResponse.json(
        {
          error: `You already hold ${minted.cap} unused codes. Spend one before minting another.`,
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
