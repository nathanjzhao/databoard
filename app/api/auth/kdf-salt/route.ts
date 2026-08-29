/**
 * GET /api/auth/kdf-salt
 *
 * Reply: { salt } for the SIGNED-IN user, 401 otherwise.
 *
 * The per-user KDF salt (user_kdf_salt) mixed into the client-side identity
 * key derivation (lib/e2ee.ts). Login and signup already deliver it in their
 * responses; this endpoint is for the flows that re-derive keys from the
 * password WITHOUT a fresh login (the in-thread unlock panel, the exchange
 * stepper, the party-signature panel), so they can fetch the same salt against
 * their existing session.
 *
 * It only ever returns the CURRENT session user's own salt: there is no handle
 * parameter, and no way to ask for another account's salt. That is the whole
 * point (F-01): the salt for a victim's handle must never be obtainable by an
 * attacker who is not that victim, or the offline password oracle reopens.
 * Sitting under the /api/auth/ public prefix only gets the request past the
 * cookie-presence middleware; the real check is getSessionUser here.
 */

import { NextResponse } from "next/server";
import { ensureKdfSalt, getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const salt = await ensureKdfSalt(user.id);
    return NextResponse.json(
      { salt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
