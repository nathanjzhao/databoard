/**
 * POST /api/threads/:id/keys
 *
 * Install the end-to-end encryption keys for one thread, exactly once. The
 * first participant's client to open a keyless thread generates a random
 * thread key, wraps it for every seat's registered X25519 public key, and
 * posts the full set here. The server stores wrapped bytes it cannot open
 * and refuses ever to replace them (a swap is what a key-substitution
 * attack looks like), so a concurrent second setup gets "already_set" and
 * simply refetches the winner's wraps.
 *
 * Body:  { keys: [{ username, wrappedKey, ephPubkey }] }  (one per seat)
 * Reply: { ok: true } | { error }  (409 already_set, 400 otherwise)
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { installThreadKeys } from "../../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let body: {
    keys?: { username?: string; wrappedKey?: string; ephPubkey?: string }[];
  };
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

    const { id } = await context.params;
    const entries = Array.isArray(body.keys)
      ? body.keys.map((k) => ({
          username: String(k?.username ?? ""),
          wrappedKey: String(k?.wrappedKey ?? ""),
          ephPubkey: String(k?.ephPubkey ?? ""),
        }))
      : [];

    const result = await installThreadKeys(id, user.id, entries);
    if (!result.ok) {
      switch (result.error) {
        case "not_participant":
          return NextResponse.json({ error: "No such thread." }, { status: 404 });
        case "already_set":
          return NextResponse.json(
            { error: "Keys are already installed for this thread." },
            { status: 409 },
          );
        case "missing_pubkeys":
          return NextResponse.json(
            { error: "A participant has no encryption key; this thread stays unencrypted." },
            { status: 400 },
          );
        case "bad_entries":
          return NextResponse.json(
            { error: "Expected exactly one well-formed wrapped key per participant." },
            { status: 400 },
          );
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
