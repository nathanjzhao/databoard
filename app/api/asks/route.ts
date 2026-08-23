/**
 * POST /api/asks
 *
 * Body:  { title, category, description, modalityTags, volume, priceBand,
 *          supplyFilledPct, buyer }
 * Reply: { id }
 *
 * The one route where a buyer name crosses the wire. It arrives in `buyer`,
 * goes through buyerToken() (HMAC keyed with the server pepper), and is gone
 * by the time the INSERT runs. It is never logged, never echoed back, and
 * there is no column it could land in. Everything else is stored as typed,
 * which the compose form says out loud.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError, getDb, now } from "@/lib/db";
import { buyerToken, newId } from "@/lib/crypto";
import { isKnownBuyer } from "@/lib/buyers";
import { CATEGORIES, MODALITIES, PRICE_BANDS, packTags } from "@/lib/taxonomy";
import { clampPct, statusForPct } from "@/components/ask/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TITLE = 140;
const MAX_DESCRIPTION = 4000;
const MAX_VOLUME = 80;
const MAX_BUYER = 80;

const CATEGORY_SLUGS = new Set<string>(CATEGORIES.map((c) => c.slug));
const MODALITY_SET = new Set<string>(MODALITIES);
const PRICE_BAND_SET = new Set<string>(PRICE_BANDS);

type Body = {
  title?: string;
  category?: string;
  description?: string;
  modalityTags?: string[];
  volume?: string;
  priceBand?: string;
  supplyFilledPct?: number;
  buyer?: string;
};

function problem(body: Body): string | null {
  const title = (body.title ?? "").trim();
  if (title.length < 8) return "Give the title at least 8 characters.";
  if (title.length > MAX_TITLE) return `Title: ${MAX_TITLE} characters max.`;

  if (!CATEGORY_SLUGS.has(body.category ?? "")) return "Pick a category from the list.";

  if ((body.description ?? "").length > MAX_DESCRIPTION) {
    return `Description: ${MAX_DESCRIPTION} characters max.`;
  }

  const tags = body.modalityTags ?? [];
  if (!Array.isArray(tags) || tags.some((t) => !MODALITY_SET.has(t))) {
    return "Modality tags must come from the list.";
  }

  if ((body.volume ?? "").trim().length > MAX_VOLUME) {
    return `Volume: ${MAX_VOLUME} characters max.`;
  }

  if (!PRICE_BAND_SET.has(body.priceBand ?? "")) {
    return "Pick a price band. Undisclosed is a valid answer.";
  }

  const pct = body.supplyFilledPct;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    return "Supply filled must be between 0 and 100.";
  }

  const buyer = (body.buyer ?? "").trim();
  if (buyer.length === 0) return "Name the buyer. It is keyed and discarded, not stored.";
  if (buyer.length > MAX_BUYER) return `Buyer name: ${MAX_BUYER} characters max.`;

  return null;
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const bad = problem(body);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });

  // The name -> token transform, and the last moment the name exists.
  let token: string;
  try {
    token = buyerToken(body.buyer ?? "");
  } catch {
    return NextResponse.json(
      { error: "That buyer name is empty once normalized. Type a real one." },
      { status: 400 },
    );
  }
  const buyerIsOther = isKnownBuyer(body.buyer ?? "") ? 0 : 1;

  const pct = clampPct(body.supplyFilledPct ?? 0);
  const id = newId("ask");

  try {
    const db = await getDb();
    await db.execute({
      sql: `INSERT INTO asks
              (id, user_id, title, category, description, modality_tags, volume,
               price_band, supply_filled_pct, buyer_token, buyer_is_other, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        user.id,
        (body.title ?? "").trim(),
        body.category ?? "",
        (body.description ?? "").trim(),
        packTags(body.modalityTags ?? []),
        (body.volume ?? "").trim(),
        body.priceBand ?? "",
        pct,
        token,
        buyerIsOther,
        statusForPct(pct),
        now(),
      ],
    });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  return NextResponse.json({ id }, { status: 201 });
}
