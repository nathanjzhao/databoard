/**
 * lib/mandates.ts
 *
 * Mandate commitments on asks: one SHA-256 fingerprint of the mandate
 * document (RFP, MSA, buyer email thread), hashed in the poster's browser,
 * write-once per ask. This file is the single write path, used by both API
 * routes and the seed script, so the ownership check and the no-replace rule
 * live in exactly one place.
 *
 * The write-once rule is enforced with INSERT OR IGNORE against the primary
 * key: a second commit affects zero rows and reports already_committed, and
 * two racing commits cannot both land. Replacing a hash is how a poster
 * would swap documents after the fact, which is the exact move a commitment
 * exists to make provable, so there is no update path at all.
 */

import { getDb, now } from "./db.ts";

export const MAX_MANDATE_LABEL_LENGTH = 80;
const MANDATE_HASH_RE = /^[0-9a-f]{64}$/;

export type Mandate = {
  docHash: string;
  label: string;
  committedAt: number;
};

export type MandateInput = { docHash?: string; label?: string };

export type CommitMandateResult =
  | { ok: true; mandate: Mandate }
  | {
      ok: false;
      error: "bad_hash" | "bad_label" | "not_found" | "not_owner" | "already_committed";
    };

/** Lowercased 64-hex or null. The one place hash shape is decided. */
export function normalizeMandateHash(hash: string): string | null {
  const h = (hash ?? "").trim().toLowerCase();
  return MANDATE_HASH_RE.test(h) ? h : null;
}

/**
 * User-facing validation for a mandate payload, shared by the create-ask
 * route and the later-commit route so both reject with the same words.
 * Returns null when the payload is acceptable.
 */
export function mandateProblem(input: MandateInput): string | null {
  if (normalizeMandateHash(input.docHash ?? "") === null) {
    return "Mandate hash must be 64 hex characters (a SHA-256, computed in your browser).";
  }
  const label = (input.label ?? "").trim();
  if (label.length === 0) return "Give the mandate a label.";
  if (label.length > MAX_MANDATE_LABEL_LENGTH) {
    return `Mandate label: ${MAX_MANDATE_LABEL_LENGTH} characters max.`;
  }
  return null;
}

/**
 * Commit a mandate to an ask the caller owns. Write-once: an ask that
 * already has a mandate keeps it, and the caller is told so.
 */
export async function commitMandate(
  askId: string,
  userId: string,
  input: MandateInput,
): Promise<CommitMandateResult> {
  const hash = normalizeMandateHash(input.docHash ?? "");
  if (hash === null) return { ok: false, error: "bad_hash" };
  const label = (input.label ?? "").trim();
  if (label.length === 0 || label.length > MAX_MANDATE_LABEL_LENGTH) {
    return { ok: false, error: "bad_label" };
  }

  const db = await getDb();
  const askRs = await db.execute({
    sql: `SELECT user_id FROM asks WHERE id = ?`,
    args: [askId],
  });
  const ask = askRs.rows[0];
  if (!ask) return { ok: false, error: "not_found" };
  if (String(ask.user_id) !== userId) return { ok: false, error: "not_owner" };

  const t = now();
  const ins = await db.execute({
    sql: `INSERT OR IGNORE INTO ask_mandates (ask_id, doc_hash, label, committed_at)
          VALUES (?, ?, ?, ?)`,
    args: [askId, hash, label, t],
  });
  if (ins.rowsAffected === 0) return { ok: false, error: "already_committed" };

  return { ok: true, mandate: { docHash: hash, label, committedAt: t } };
}

/** The mandate on an ask, or null. */
export async function getMandate(askId: string): Promise<Mandate | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT doc_hash, label, committed_at FROM ask_mandates WHERE ask_id = ?`,
    args: [askId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return {
    docHash: String(row.doc_hash),
    label: String(row.label),
    committedAt: Number(row.committed_at),
  };
}
