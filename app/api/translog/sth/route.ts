/**
 * GET /api/translog/sth
 *
 * The latest Signed Tree Head of the append-only transparency log, or the STH
 * at a specific size with ?size=N (every size the log has ever been at signs
 * one canonical head). Public, no session (lib/gate.ts): the whole point of a
 * transparency log is that anyone can pull the head and the proofs.
 *
 *   { v, logId, treeSize, rootHash, timestamp, signature,
 *     cosignatures: [...], witnessing: { required, recognized, present, met } }
 *
 * The signature is Ed25519 over the canonical head; verify it against the key
 * at /api/translog/pubkey. The core head fields (v..signature) are the exact
 * bytes the log signed, so an old verifier that ignores the extra fields still
 * checks out. `cosignatures` are independent-witness cosignatures (C2SP
 * tlog-witness, lib/witness.ts) over this head, and `witnessing` reports the
 * N-of-M quorum: a head with met=false is unwitnessed and should be trusted
 * only with that caveat. See lib/translog.ts for what the log records (all
 * metadata, no PII) and the honest boundary on the operator forking it.
 */

import { NextResponse } from "next/server";
import { DbNotConfiguredError } from "@/lib/db";
import { getWitnessedHead } from "@/lib/translog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sizeParam = new URL(request.url).searchParams.get("size");
  let size: number | undefined;
  if (sizeParam != null) {
    const n = Number(sizeParam);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: "size must be a non-negative integer." }, { status: 400 });
    }
    size = n;
  }
  try {
    const sth = await getWitnessedHead(size);
    return NextResponse.json(sth, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
