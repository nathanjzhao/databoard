/**
 * /api/e2ee/pubkey
 *
 * The signed-in user's X25519 PUBLIC key for end-to-end encrypted messages.
 * Public key material only; the private half is derived from the password
 * in the browser (lib/e2ee.ts) and never travels.
 *
 * GET    -> { username, pubkey | null }
 * POST   { pubkey } -> { pubkey }   registers it, WRITE-ONCE: the first key
 *        an account registers is the key, and later posts return the stored
 *        one untouched. Overwriting would let a hijacked session swap the
 *        key and intercept future thread keys, so there is no verb for it.
 *        Accounts predating encryption get their key backfilled here on
 *        their next login (the client re-derives it from the password it
 *        just proved it knows).
 *
 * Reply on POST includes the stored key so the client can detect a
 * mismatch between what it derived and what the server holds, and say so
 * out loud instead of failing quietly.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError, getDb, now } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding

async function storedPubkey(userId: string): Promise<string | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT pubkey FROM user_e2ee_keys WHERE user_id = ?`,
    args: [userId],
  });
  return rs.rows[0] ? String(rs.rows[0].pubkey) : null;
}

export async function GET() {
  try {
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
    if (!PUBKEY_RE.test(pubkey)) {
      return NextResponse.json(
        { error: "Expected a 32-byte base64url public key." },
        { status: 400 },
      );
    }

    const db = await getDb();
    // Write-once: INSERT OR IGNORE keeps the first key an account ever
    // registered; the response reports whichever key actually stands.
    await db.execute({
      sql: `INSERT OR IGNORE INTO user_e2ee_keys (user_id, pubkey, created_at)
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
