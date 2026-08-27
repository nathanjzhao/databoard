/**
 * GET /api/translog/proof/inclusion?leaf=<hash>
 *
 * An RFC 6962 inclusion proof for a leaf hash: the audit path proving the leaf
 * is in the tree at a given size, plus the Signed Tree Head over that size.
 * Public (lib/gate.ts). Verify it client-side with lib/merkle.ts: recompute
 * the root from the leaf and path, check it equals sth.rootHash, and check the
 * STH signature against /api/translog/pubkey. The browser verifier on
 * /transparency/log and scripts/verify-log.sh both do exactly that.
 *
 *   { leafHash, leafIndex, treeSize, auditPath: [...], rootHash, sth }
 *
 * A leaf hash that is not in the log returns 404: a receipt or hash that is
 * not logged is a normal answer, not an error. The leaf hash of a receipt is
 * the `log.leafHash` its verify result carries.
 */

import { NextResponse } from "next/server";
import { DbNotConfiguredError } from "@/lib/db";
import { inclusionProofFor } from "@/lib/translog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const leaf = new URL(request.url).searchParams.get("leaf") ?? "";
  try {
    const proof = await inclusionProofFor(leaf);
    if (!proof) {
      return NextResponse.json(
        { error: "No such leaf in the log.", leaf: leaf.trim().toLowerCase() },
        { status: 404, headers: { "Cache-Control": "no-store" } },
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
