/**
 * GET /api/translog/proof/consistency?from=<size>&to=<size>
 *
 * An RFC 6962 consistency proof that the size-`from` tree is an exact prefix
 * of the size-`to` tree: proof that between those two checkpoints the log only
 * appended, nothing was rewritten. Public (lib/gate.ts). This is the
 * append-only witness; verify it client-side with lib/merkle.ts against the
 * two signed heads it returns.
 *
 *   { first, second, firstRoot, secondRoot, proof: [...], firstSth, secondSth }
 *
 * Out-of-range sizes (to > current tree size, from > to) return 400.
 */

import { NextResponse } from "next/server";
import { DbNotConfiguredError } from "@/lib/db";
import { consistencyProofBetween } from "@/lib/translog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const from = Number(sp.get("from"));
  const to = Number(sp.get("to"));
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return NextResponse.json(
      { error: "from and to must be integers." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const proof = await consistencyProofBetween(from, to);
    if (!proof) {
      return NextResponse.json(
        { error: "Sizes out of range: need 0 <= from <= to <= current tree size." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(proof, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
