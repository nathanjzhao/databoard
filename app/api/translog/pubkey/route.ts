/**
 * GET /api/translog/pubkey
 *
 * The Ed25519 public key that signs the transparency log's tree heads, plus
 * the exact key derivation, so anyone can check that the key printed on
 * /transparency/log is the key the server actually signs with, and verify an
 * STH offline (scripts/verify-log.sh). Public on purpose (lib/gate.ts).
 *
 * Publishing this reveals nothing: it is a verification key. Honest caveat,
 * repeated on /transparency/log: because the key is HMAC-derived from
 * SERVER_PEPPER, the operator holds the matching private key and could sign a
 * fork. Consistency proofs plus the external git anchor make a rewrite or a
 * fork detectable after the fact; independent co-signing witnesses are the
 * future upgrade that would make it impossible.
 */

import { NextResponse } from "next/server";
import { logPublicKeyHex, logId, TRANSLOG_HKDF_LABEL, STH_VERSION } from "@/lib/translog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      algorithm: "Ed25519",
      sthVersion: STH_VERSION,
      logId: logId(),
      publicKey: logPublicKeyHex(),
      keyDerivation:
        `HKDF-SHA256(SERVER_PEPPER, salt "databoard", info "${TRANSLOG_HKDF_LABEL}") ` +
        `into a 32-byte Ed25519 seed`,
      merkle: "RFC 6962 (leaf prefix 0x00, node prefix 0x01, SHA-256)",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
