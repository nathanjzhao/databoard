/**
 * POST /api/asks/[id]/mandate
 *
 * The owner's later mandate commitment, write-once.
 *
 * Body:  { docHash, label }   64-hex SHA-256 the browser computed, plus a
 *                             short caption. The document never arrives.
 * Reply: { docHash, label, committedAt }
 *
 * committed_at is stamped now, not at posting time, and the ask page prints
 * both dates side by side: a mandate pinned late is visibly late. There is
 * no PATCH and no DELETE, because a replaceable hash pins nothing; an ask
 * that already has a mandate answers 409 and keeps the one it has.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import { commitMandate, mandateProblem, type MandateInput } from "@/lib/mandates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { id } = await params;

  let body: MandateInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const bad = mandateProblem(body ?? {});
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });

  try {
    const result = await commitMandate(id, user.id, body);
    if (!result.ok) {
      switch (result.error) {
        case "bad_hash":
        case "bad_label":
          // mandateProblem() above catches these first; kept for the direct
          // library callers and as a second fence.
          return NextResponse.json(
            { error: "Malformed mandate commitment." },
            { status: 400 },
          );
        case "not_found":
          return NextResponse.json({ error: "No such ask." }, { status: 404 });
        case "not_owner":
          return NextResponse.json({ error: "Not your ask." }, { status: 403 });
        case "already_committed":
          return NextResponse.json(
            {
              error:
                "This ask already has a mandate. Commitments are write-once; a replaceable hash would pin nothing.",
            },
            { status: 409 },
          );
      }
    }
    return NextResponse.json(result.mandate, { status: 201 });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
