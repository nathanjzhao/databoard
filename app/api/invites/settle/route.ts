/**
 * POST /api/invites/settle
 *
 * The two settlement verbs on the referral ledger, both recording only:
 *
 *   { action: "record", payerUsername, amountUsd, note? }
 *       The caller is the PAYEE (the ancestor): they record money received
 *       off the platform from a descendant. amountUsd may carry cents
 *       ("162.50"); it is stored as integer cents.
 *
 *   { action: "confirm", settlementId }
 *       The caller is the PAYER: they co-sign a settlement their ancestor
 *       recorded. Own rows only.
 *
 * No money moves here or anywhere else on the platform. The rows are the
 * two-sided receipt, nothing more.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { DbNotConfiguredError } from "@/lib/db";
import {
  MAX_SETTLEMENT_NOTE_LENGTH,
  confirmSettlement,
  recordSettlement,
} from "@/lib/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  action?: string;
  payerUsername?: string;
  amountUsd?: number;
  note?: string;
  settlementId?: string;
};

/** Dollars (possibly with cents) to integer cents, or null when unusable. */
function toCents(amountUsd: unknown): number | null {
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) return null;
  const cents = Math.round(amountUsd * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    if (body.action === "record") {
      const cents = toCents(body.amountUsd);
      if (cents == null) {
        return NextResponse.json(
          { error: "Amount must be a dollar figure above zero." },
          { status: 400 },
        );
      }
      const result = await recordSettlement(
        user.id,
        String(body.payerUsername ?? ""),
        cents,
        String(body.note ?? ""),
      );
      if (!result.ok) {
        const copy: Record<typeof result.error, string> = {
          unknown_username: "No account by that handle.",
          not_in_chain: "That account is not in your downline within 6 steps.",
          bad_amount: "Amount must be a dollar figure above zero.",
          bad_note: `Note: ${MAX_SETTLEMENT_NOTE_LENGTH} characters max.`,
        };
        return NextResponse.json({ error: copy[result.error] }, { status: 400 });
      }
      return NextResponse.json({ id: result.id }, { status: 201 });
    }

    if (body.action === "confirm") {
      const result = await confirmSettlement(String(body.settlementId ?? ""), user.id);
      if (!result.ok) {
        return NextResponse.json(
          {
            error:
              result.error === "already_confirmed"
                ? "Already confirmed."
                : "No such settlement on your side of the ledger.",
          },
          { status: result.error === "already_confirmed" ? 409 : 404 },
        );
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    if (err instanceof DbNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
