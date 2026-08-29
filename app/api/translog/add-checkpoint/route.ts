/**
 * POST /api/translog/add-checkpoint
 *
 * The log side of the C2SP tlog-witness protocol: an endpoint an independent
 * witness posts its cosignature to, so the live signed head can carry it. The
 * body is one WitnessCosignature (lib/witness.ts):
 *
 *   { v, witnessId, keyName, logId, treeSize, rootHash, cosignedAt,
 *     publicKey, signature }
 *
 * The log accepts it only when it is from a RECOGNIZED witness, over a head
 * this log actually signed (same size AND same root), and a valid Ed25519
 * signature by that witness's registered key (lib/translog.storeWitnessCosignature).
 * That cryptographic acceptance is the authentication: no session and no shared
 * secret are needed, because only the witness holding the key can produce a
 * passing cosignature, and it must bind to a head we ourselves issued. A
 * witness that already cosigned a size with a different root is refused as a
 * `witness_fork` rather than overwritten.
 *
 * Public (lib/gate.ts, /api/translog/ prefix), like the rest of the log API.
 * The witness runner (scripts/witness.ts) also commits its cosignature to git
 * under docs/transparency-log/witnesses/, so this endpoint is the runtime path
 * and the committed file is the external, operator-independent record.
 */

import { NextResponse } from "next/server";
import { DbNotConfiguredError } from "@/lib/db";
import { storeWitnessCosignature } from "@/lib/translog";
import type { WitnessCosignature } from "@/lib/witness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  let cosig: WitnessCosignature;
  try {
    cosig = (await request.json()) as WitnessCosignature;
  } catch {
    return NextResponse.json(
      { error: "Body must be a JSON witness cosignature." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!cosig || typeof cosig !== "object" || typeof cosig.signature !== "string") {
    return NextResponse.json(
      { error: "Malformed cosignature." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await storeWitnessCosignature(cosig);
    // 201 for a fresh store, 200 for an idempotent dedupe, 4xx for a refusal.
    // A witness_fork is a 409: the witness itself diverged, which the caller
    // (and the operator) must see, not a transient error to retry.
    const status =
      result.status === "stored"
        ? 201
        : result.status === "deduped"
          ? 200
          : result.status === "witness_fork"
            ? 409
            : result.status === "unrecognized"
              ? 403
              : 400;
    return NextResponse.json(
      { status: result.status, message: result.message, witnessId: cosig.witnessId, treeSize: cosig.treeSize },
      { status, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503, headers: NO_STORE });
    }
    throw err;
  }
}
