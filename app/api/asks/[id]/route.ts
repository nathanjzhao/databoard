/**
 * PATCH /api/asks/[id]
 *
 * Owner-only lifecycle updates, and nothing else is editable:
 *   { supplyFilledPct: 0..100 }  adjusts the meter; status follows the number
 *                                (0 open, 1-99 partial, 100 closed).
 *   { close: true }              closes the ask at its current fill.
 *
 * Reply: { supplyFilledPct, status }
 *
 * Titles and descriptions are not editable after posting: the board is a
 * record of what was asked, not a wiki. Close it and post again.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError, getDb } from "@/lib/db";
import { clampPct, statusForPct } from "@/components/ask/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { supplyFilledPct?: number; close?: boolean };

export async function PATCH(
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
    const db = await getDb();
    const rs = await db.execute({
      sql: `SELECT user_id, supply_filled_pct, status FROM asks WHERE id = ?`,
      args: [id],
    });
    const row = rs.rows[0];
    if (!row) return NextResponse.json({ error: "No such ask." }, { status: 404 });
    if (String(row.user_id) !== user.id) {
      return NextResponse.json({ error: "Not your ask." }, { status: 403 });
    }

    if (body.close === true) {
      const pct = clampPct(Number(row.supply_filled_pct));
      await db.execute({
        sql: `UPDATE asks SET status = 'closed' WHERE id = ?`,
        args: [id],
      });
      return NextResponse.json({ supplyFilledPct: pct, status: "closed" });
    }

    const pctRaw = body.supplyFilledPct;
    if (typeof pctRaw !== "number" || !Number.isFinite(pctRaw) || pctRaw < 0 || pctRaw > 100) {
      return NextResponse.json(
        { error: "Send supplyFilledPct between 0 and 100, or close: true." },
        { status: 400 },
      );
    }
    if (String(row.status) === "closed") {
      return NextResponse.json(
        { error: "This ask is closed. Closed asks do not take supply updates." },
        { status: 409 },
      );
    }

    const pct = clampPct(pctRaw);
    const status = statusForPct(pct);
    await db.execute({
      sql: `UPDATE asks SET supply_filled_pct = ?, status = ? WHERE id = ?`,
      args: [pct, status, id],
    });
    return NextResponse.json({ supplyFilledPct: pct, status });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
