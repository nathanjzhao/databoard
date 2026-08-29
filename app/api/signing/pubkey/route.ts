/**
 * /api/signing/pubkey
 *
 * The account's Ed25519 PUBLIC signing key: the sibling of /api/e2ee/pubkey.
 * Public key material only; the private half is derived from the password in
 * the browser (lib/e2ee.ts deriveSigningKeys) and never travels.
 *
 * GET ?handle=<h> -> { handle, pubkey | null }   Key directory, SESSION-GATED.
 *        A signed-in caller can look up the signing key registered for a handle,
 *        to cross-check that a party signature's key is the one the board holds.
 *        It used to be public, but the pubkey is a deterministic function of
 *        (password, handle), so a public directory was an offline
 *        password-cracking oracle (F-01): anyone could fetch a handle's key and
 *        brute-force the password with no account. It now requires a session,
 *        downgrading the oracle from "anyone on the internet" to "an attacker
 *        who already holds a session"; the durable fix is the per-user KDF salt
 *        (lib/e2ee.ts). Honest limit, stated on /transparency: it is an
 *        operator-served directory, i.e. trust-on-first-use, not key
 *        transparency.
 * GET    -> { username, pubkey | null }   the signed-in user's own key.
 * POST   { pubkey } -> { pubkey }   registers it, WRITE-ONCE, exactly like the
 *        e2ee key: the first key an account registers is the key, and later
 *        posts return the stored one untouched, because a swap would let a
 *        hijacked session forge that account's attestations. pubkey is 43
 *        base64url characters (a 32-byte Ed25519 key). The reply echoes it so
 *        the client can detect a mismatch and say so out loud.
 *
 * Every verb here enforces a session (getSessionUser). Public /receipts/verify
 * still works without one: a receipt verifies against the signer pubkeys it
 * already carries in its attestation roster; only the extra directory
 * cross-check is gated behind a session.
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
    // Every read requires a session now: the directory is no longer a public,
    // no-account oracle (F-01).
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    // Directory read: another handle's registered signing key, for the
    // logged-in receipt cross-check.
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
    // Own-key read.
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
