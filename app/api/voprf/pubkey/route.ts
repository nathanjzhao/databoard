/**
 * GET /api/voprf/pubkey
 *
 * The server's VOPRF public key and the exact protocol parameters, so that
 * anyone can independently verify what the compose forms verify on every
 * mint: that one key answers everybody. Public on purpose (lib/gate.ts);
 * /transparency prints the same key, and the two agreeing is checkable from
 * a logged-out browser.
 *
 * Publishing this key reveals nothing about buyer names: it is a curve
 * point, and the DLEQ proofs it anchors are zero-knowledge.
 */

import { NextResponse } from "next/server";
import { getVoprfPublicKeyHex } from "../server";
import {
  VOPRF_SUITE,
  VOPRF_HKDF_LABEL,
  VOPRF_INPUT_DOMAIN,
  BUYER_TOKEN_V2_PREFIX,
} from "@/lib/voprf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const publicKey = await getVoprfPublicKeyHex();
  return NextResponse.json({
    protocol: "RFC 9497 VOPRF (OPRFV1, verifiable mode)",
    suite: VOPRF_SUITE,
    publicKey,
    keyDerivation:
      `HKDF-SHA256(SERVER_PEPPER, salt "databoard", info "${VOPRF_HKDF_LABEL}") ` +
      `into RFC 9497 DeriveKeyPair with the same info label`,
    inputDomain: VOPRF_INPUT_DOMAIN,
    tokenFormat: `${BUYER_TOKEN_V2_PREFIX}<hex of the 64-byte Finalize output>`,
  });
}
