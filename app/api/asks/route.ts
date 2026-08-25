/**
 * POST /api/asks
 *
 * Body:  { title, category, description, modalityTags, volume, priceBand,
 *          supplyFilledPct, buyerTokenV2, buyerIsOther }
 * Reply: { id }
 *
 * No buyer name crosses the wire here any more, in any form. The browser
 * blinds the name, has /api/voprf/evaluate compute the token without seeing
 * it, verifies the proof, and submits only the finished "v2:" token
 * (lib/voprf.ts). A request that still carries a `buyer` field is rejected
 * outright rather than quietly accepted, so the old behavior cannot be
 * resurrected by an old client. Everything else is stored as typed, which
 * the compose form says out loud.
 *
 * Optionally the body carries mandate: { docHash, label }, the SHA-256 of
 * the mandate document computed in the poster's browser (the document itself
 * never arrives). Committed here, it lands in ask_mandates in the same
 * transaction as the ask, stamped with the same timestamp, so the ask page
 * can honestly say "committed with the post". Later commits go through
 * POST /api/asks/[id]/mandate and wear their own, later, timestamp.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError, getDb, now } from "@/lib/db";
import { newId } from "@/lib/crypto";
import { isBuyerTokenV2 } from "@/lib/voprf";
import { mandateProblem, normalizeMandateHash, type MandateInput } from "@/lib/mandates";
import { CATEGORIES, MODALITIES, PRICE_BANDS, packTags } from "@/lib/taxonomy";
import { clampPct, statusForPct } from "@/components/ask/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TITLE = 140;
const MAX_DESCRIPTION = 4000;
const MAX_VOLUME = 80;

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
  buyerTokenV2?: string;
  buyerIsOther?: boolean;
  mandate?: MandateInput | null;
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

  if ("buyer" in body) {
    // A raw name showing up at all means an out-of-date or hostile client.
    return "This API no longer accepts a buyer name in any form. Send the blinded token.";
  }
  if (!isBuyerTokenV2(body.buyerTokenV2 ?? "")) {
    return "Missing or malformed blinded buyer token.";
  }
  if (typeof body.buyerIsOther !== "boolean") {
    return "Say whether the buyer was off-list.";
  }

  if (body.mandate != null) {
    if (typeof body.mandate !== "object") return "Mandate must be an object.";
    const bad = mandateProblem(body.mandate);
    if (bad) return bad;
  }

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

  // Already a token: the browser minted it under the published key and
  // verified the proof before sending. The name it encodes never existed on
  // this side of the wire. buyer_is_other stays what it always was, a
  // single self-declared honesty bit about the dropdown.
  const token = body.buyerTokenV2 ?? "";
  const buyerIsOther = body.buyerIsOther ? 1 : 0;

  const pct = clampPct(body.supplyFilledPct ?? 0);
  const id = newId("ask");
  const t = now();

  try {
    const db = await getDb();
    const statements = [
      {
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
          t,
        ],
      },
    ];
    if (body.mandate != null) {
      // Same timestamp as the ask row: committed with the post, and the ask
      // page's honesty line can say exactly that. problem() already
      // validated the shape.
      statements.push({
        sql: `INSERT INTO ask_mandates (ask_id, doc_hash, label, committed_at)
              VALUES (?, ?, ?, ?)`,
        args: [
          id,
          normalizeMandateHash(body.mandate.docHash ?? "") ?? "",
          (body.mandate.label ?? "").trim(),
          t,
        ] as (string | number)[],
      });
    }
    await db.batch(statements, "write");
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  return NextResponse.json({ id }, { status: 201 });
}
