/**
 * lib/terms.ts
 *
 * Exclusivity terms for asks: the ask_terms table, one row per ask, written
 * with the post. The vocabulary is two words on purpose; anything more
 * nuanced belongs in the description, in the poster's own words.
 *
 * The type and guard live here so the compose form, the POST route and the
 * display components agree on spelling. Server reads stay in this module;
 * the chip that renders the value is components/ask/terms.tsx.
 */

import { getDb } from "./db.ts";

export const EXCLUSIVITY_VALUES = ["exclusive", "nonexclusive"] as const;
export type Exclusivity = (typeof EXCLUSIVITY_VALUES)[number];

export function isExclusivity(v: unknown): v is Exclusivity {
  return v === "exclusive" || v === "nonexclusive";
}

/** The terms row for one ask, or null for asks that predate ask_terms. */
export async function getAskTerms(askId: string): Promise<Exclusivity | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT exclusivity FROM ask_terms WHERE ask_id = ?`,
    args: [askId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return isExclusivity(String(row.exclusivity)) ? (String(row.exclusivity) as Exclusivity) : null;
}
