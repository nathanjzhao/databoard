/**
 * /api/exchange/[id]/blob   (DEMO ciphertext carrier)
 *
 * The demo path's opaque ciphertext store. In production the encrypted chunks
 * move off the platform (directly, or through the E2EE thread as ciphertext);
 * this endpoint exists so the flow is testable end to end in one place. The
 * server treats the blob as bytes it cannot read: it is AEAD ciphertext under
 * a key the server never sees, and the buyer verifies it against the committed
 * ciphertext root before trusting it.
 *
 * POST { ciphertext: base64url }  -> { length }   seller only, size-capped
 * GET                             -> { ciphertext } either participant
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { getDemoBlob, setDemoBlob, httpStatusFor } from "../../store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;

  let body: { ciphertext?: string };
  try {
    body = (await request.json()) as { ciphertext?: string };
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    const result = await setDemoBlob(id, user.id, String(body.ciphertext ?? ""));
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, detail: result.detail },
        { status: httpStatusFor(result.error) },
      );
    }
    return NextResponse.json({ length: result.value.length });
  } catch (e) {
    if (e instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  try {
    const result = await getDemoBlob(id, user.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: httpStatusFor(result.error) });
    }
    return NextResponse.json({ ciphertext: result.value });
  } catch (e) {
    if (e instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }
}
