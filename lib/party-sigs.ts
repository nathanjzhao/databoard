/**
 * lib/party-sigs.ts
 *
 * Server side of the receipt party-signature layer (lib/receipt-attest.ts is
 * the isomorphic crypto; this is the database half). It owns three things:
 *
 *   - the SIGNER ROSTER for a deal: which confirmed participants hold a
 *     registered Ed25519 signing key (user_signing_keys), as {handle, pubkey};
 *   - the COLLECTED signatures for a receipt state (deal_receipt_signatures at
 *     a given translog seq), as {handle, sig};
 *   - STORING one party's signature, write-once per (deal, user, seq).
 *
 * It stores no data, no keys, no amounts: public signing pubkeys, public
 * signatures, blinded/bucketed receipt fields. The receipt itself is minted by
 * lib/translog.ts loggedReceiptForDeal, which calls attestationForDeal to fold
 * the roster and the sigs so far into the token.
 */

import { getDb } from "./db.ts";
import type { DealDetail } from "./deals.ts";
import {
  sortSigners,
  type ReceiptSigner,
  type ReceiptPartySig,
  type ReceiptAttestation,
} from "./receipt-attest.ts";

/** The confirmed rows on a deal (reporter included; declined/pending excluded). */
function confirmedRows(deal: DealDetail): { userId: string; handle: string }[] {
  return deal.split
    .filter((r) => r.status === "confirmed")
    .map((r) => ({ userId: r.userId, handle: r.username }));
}

/** hex signing pubkey per user id, for the users that have registered one. */
export async function signingPubkeysFor(
  userIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  const db = await getDb();
  const placeholders = userIds.map(() => "?").join(", ");
  const rs = await db.execute({
    sql: `SELECT user_id, pubkey FROM user_signing_keys WHERE user_id IN (${placeholders})`,
    args: userIds,
  });
  for (const r of rs.rows) out.set(String(r.user_id), String(r.pubkey));
  return out;
}

/**
 * The signer roster for a deal: confirmed participants who hold a registered
 * signing key, each { handle, pubkey }, in canonical (handle-sorted) order.
 * Empty when nobody on the deal has a signing key yet (a fully pre-signing
 * deal), in which case the receipt stays platform-MAC only.
 */
export async function signersRosterForDeal(deal: DealDetail): Promise<ReceiptSigner[]> {
  const confirmed = confirmedRows(deal);
  const keys = await signingPubkeysFor(confirmed.map((c) => c.userId));
  const signers: ReceiptSigner[] = [];
  for (const c of confirmed) {
    const pubkey = keys.get(c.userId);
    if (pubkey) signers.push({ handle: c.handle, pubkey });
  }
  return sortSigners(signers);
}

/**
 * The party signatures stored for one receipt state (deal + translog seq), as
 * {handle, sig}, restricted to handles that are actually on the roster so a
 * stale row (from before a roster change) never claims a seat it no longer
 * holds. Sorted by handle for a deterministic token.
 */
export async function storedPartySigs(
  dealId: string,
  seq: number,
  roster: ReceiptSigner[],
): Promise<ReceiptPartySig[]> {
  if (roster.length === 0) return [];
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT s.sig AS sig, u.username AS handle
            FROM deal_receipt_signatures s
            JOIN users u ON u.id = s.user_id
           WHERE s.deal_id = ? AND s.seq = ?`,
    args: [dealId, seq],
  });
  const onRoster = new Set(roster.map((r) => r.handle));
  return rs.rows
    .map((r) => ({ handle: String(r.handle), sig: String(r.sig) }))
    .filter((s) => onRoster.has(s.handle))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}

/**
 * The attestation block to fold into a receipt at a given translog seq: the
 * roster and the signatures collected so far. Null when no confirmed
 * participant has a registered signing key (nothing to attest with yet).
 */
export async function attestationForDeal(
  deal: DealDetail,
  seq: number,
): Promise<ReceiptAttestation | null> {
  const signers = await signersRosterForDeal(deal);
  if (signers.length === 0) return null;
  const sigs = await storedPartySigs(deal.id, seq, signers);
  return { signers, sigs };
}

export type StorePartySigResult =
  | { ok: true; stored: boolean }
  | { ok: false; error: "not_registered" | "pubkey_mismatch" };

/**
 * Store one party's signature for a receipt state, write-once per
 * (deal, user, seq). The caller (the receipt-sign route) has already verified
 * that the signature is valid over the canonical base for `pubkey`; this checks
 * that `pubkey` is the user's OWN registered signing key (so a session cannot
 * sign for a stranger's handle) and records it. A second submit for the same
 * (deal, user, seq) is a no-op, not an error.
 */
export async function storePartySig(args: {
  dealId: string;
  userId: string;
  seq: number;
  pubkey: string;
  sig: string;
  now: number;
}): Promise<StorePartySigResult> {
  const db = await getDb();
  const reg = await db.execute({
    sql: `SELECT pubkey FROM user_signing_keys WHERE user_id = ?`,
    args: [args.userId],
  });
  const registered = reg.rows[0] ? String(reg.rows[0].pubkey) : null;
  if (!registered) return { ok: false, error: "not_registered" };
  if (registered !== args.pubkey) return { ok: false, error: "pubkey_mismatch" };
  const ins = await db.execute({
    sql: `INSERT OR IGNORE INTO deal_receipt_signatures
            (deal_id, user_id, seq, pubkey, sig, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [args.dealId, args.userId, args.seq, args.pubkey, args.sig, args.now],
  });
  return { ok: true, stored: ins.rowsAffected > 0 };
}
