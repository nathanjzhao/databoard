/**
 * GET /api/translog/witnesses
 *
 * The recognized-witness registry and the quorum policy a client must apply
 * before trusting a head (the N-of-M in the C2SP tlog-witness model). Public
 * (lib/gate.ts): the whole point is that anyone verifying a head uses the SAME
 * list of witness keys the operator claims, and the same required count.
 *
 *   {
 *     quorum: { required, recognized, independent, note },
 *     witnesses: [ { keyName, witnessId, publicKey, operator, url? }, ... ]
 *   }
 *
 * The browser verifier (/transparency/log) and scripts/verify-log.sh fetch this
 * and re-verify each cosignature on /api/translog/sth against the registered
 * key. `operator: true` marks a witness the log operator runs: it counts, but
 * it is flagged everywhere so "witnessed" is never read as "independently
 * witnessed". Fork resistance needs 2*required > recognized AND enough
 * non-operator witnesses; see /transparency/log for the honest account.
 */

import { NextResponse } from "next/server";
import { recognizedWitnesses, witnessQuorumN } from "@/lib/witnesses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const witnesses = recognizedWitnesses();
  const required = witnessQuorumN();
  const independent = witnesses.filter((w) => !w.operator).length;
  return NextResponse.json(
    {
      quorum: {
        required,
        recognized: witnesses.length,
        independent,
        // 2N > M is the overlap bound that makes two same-size quorums share a
        // witness; with only operator-run witnesses it is partial independence.
        forkResistant: 2 * required > witnesses.length && independent >= required,
        note:
          "A head is trusted only with >= `required` valid cosignatures from these witnesses. " +
          "2*required > recognized guarantees any two same-size quorums overlap in a witness, so a " +
          "fork would need a recognized witness to double-sign. Operator-run witnesses (operator: true) " +
          "count but are not independent; true fork resistance needs external witnesses.",
      },
      witnesses: witnesses.map((w) => ({
        keyName: w.keyName,
        witnessId: w.witnessId,
        publicKey: w.publicKey,
        operator: w.operator,
        ...(w.url ? { url: w.url } : {}),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
