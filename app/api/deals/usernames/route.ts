/**
 * GET /api/deals/usernames?q=<prefix>
 *
 * Username autocomplete for the record-a-deal participant picker. Members
 * only, and it returns nothing but usernames, which members already see all
 * over the board. The caller's own username is excluded server-side; you
 * cannot bring yourself into your own deal.
 *
 * Reply: { usernames: string[] }
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { searchUsernames } from "@/lib/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const usernames = await searchUsernames(q, user.id, 8);
    return NextResponse.json({ usernames });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
