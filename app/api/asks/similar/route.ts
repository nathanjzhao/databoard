/**
 * GET /api/asks/similar?token=v2:...&category=slug
 *
 * The compose form's quiet hint: how many asks already on the board name the
 * buyer the poster just picked. Counts only, and the counting key is the
 * blinded token the CALLER minted client-side through the VOPRF flow; no
 * buyer name reaches this endpoint in any form, which is the same contract
 * as POST /api/asks.
 *
 * Reply: {
 *   sameBuyerOpen:           asks with this token not yet closed,
 *   sameBuyerOpenInCategory: the subset also in ?category (0 when the
 *                            category is absent or unknown)
 * }
 *
 * Auth required: the counts are board data, and the board is members-only.
 * Hidden asks count nowhere, same as every other surface.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError, getDb } from "@/lib/db";
import { isBuyerTokenV2 } from "@/lib/voprf";
import { CATEGORIES } from "@/lib/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORY_SLUGS = new Set<string>(CATEGORIES.map((c) => c.slug));

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const categoryRaw = url.searchParams.get("category") ?? "";
  const category = CATEGORY_SLUGS.has(categoryRaw) ? categoryRaw : "";

  if (!isBuyerTokenV2(token)) {
    return NextResponse.json(
      { error: "Missing or malformed blinded buyer token." },
      { status: 400 },
    );
  }

  try {
    const db = await getDb();
    const rs = await db.execute({
      sql: `SELECT
              COUNT(*) AS same_buyer_open,
              SUM(CASE WHEN category = ? THEN 1 ELSE 0 END) AS in_category
             FROM asks
            WHERE buyer_token = ? AND status != 'closed'
              AND id NOT IN (SELECT ask_id FROM hidden_asks)`,
      args: [category, token],
    });
    const row = rs.rows[0];
    return NextResponse.json({
      sameBuyerOpen: Number(row?.same_buyer_open ?? 0),
      sameBuyerOpenInCategory: category === "" ? 0 : Number(row?.in_category ?? 0),
    });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
