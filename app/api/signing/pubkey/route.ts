/**
 * /api/signing/pubkey
 *
 * The account's Ed25519 PUBLIC signing key: the sibling of /api/e2ee/pubkey.
 * Public key material only; the private half is derived from the password in
 * the browser (lib/e2ee.ts deriveSigningKeys) and never travels.
 *
 * GET ?handle=<h> -> { handle, pubkey | null }   PUBLIC key directory. Anyone,
 *        with or without a session, can look up the signing key registered for
 *        a handle. This is what lets a receipt verifier on /receipts/verify (no
 *        account) confirm that a party signature's key is the one the board
 *        holds for that handle. It exposes only public key material bound to an
 *        already-public handle; honest limit, stated on /transparency: it is an
 *        operator-served directory, i.e. trust-on-first-use, not key
 *        transparency. Enumeration reveals only which handles have a key.
 * GET    -> { username, pubkey | null }   the signed-in user's own key.
 * POST   { pubkey } -> { pubkey }   registers it, WRITE-ONCE, exactly like the
 *        e2ee key: the first key an account registers is the key, and later
 *        posts return the stored one untouched, because a swap would let a
 *        hijacked session forge that account's attestations. pubkey is 43
 *        base64url characters (a 32-byte Ed25519 key). The reply echoes it so
 *        the client can detect a mismatch and say so out loud.
 *
 * This path is allowlisted as public in lib/gate.ts for the directory read; the
 * own-key GET and the POST enforce a session here, so a logged-out caller to
 * either simply gets a 401.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError, getDb, now } from "@/lib/db";
import { isPubkey, isHandle } from "@/lib/receipt-attest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function storedPubkey(userId: string): Promise<string | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT pubkey FROM user_signing_keys WHERE user_id = ?`,
    args: [userId],
  });
  return rs.rows[0] ? String(rs.rows[0].pubkey) : null;
}

async function pubkeyForHandle(handle: string): Promise<string | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT k.pubkey AS pubkey
            FROM user_signing_keys k
            JOIN users u ON u.id = k.user_id
           WHERE u.username = ?`,
    args: [handle],
  });
  return rs.rows[0] ? String(rs.rows[0].pubkey) : null;
}

export async function GET(request: Request) {
  const handleParam = new URL(request.url).searchParams.get("handle");
  try {
    // Public directory read: no session required.
    if (handleParam != null) {
      const handle = handleParam.trim().toLowerCase();
      if (!isHandle(handle)) {
        return NextResponse.json({ handle, pubkey: null });
      }
      const pubkey = await pubkeyForHandle(handle);
      return NextResponse.json(
        { handle, pubkey },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Own-key read: session required.
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const pubkey = await storedPubkey(user.id);
    return NextResponse.json({ username: user.username, pubkey });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}

export async function POST(request: Request) {
  let body: { pubkey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const pubkey = String(body.pubkey ?? "");
    if (!isPubkey(pubkey)) {
      return NextResponse.json(
        { error: "Expected a 32-byte base64url Ed25519 public key." },
        { status: 400 },
      );
    }

    const db = await getDb();
    // Write-once: INSERT OR IGNORE keeps the first key an account registered.
    await db.execute({
      sql: `INSERT OR IGNORE INTO user_signing_keys (user_id, pubkey, created_at)
            VALUES (?, ?, ?)`,
      args: [user.id, pubkey, now()],
    });
    const stored = await storedPubkey(user.id);
    return NextResponse.json({ pubkey: stored });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
