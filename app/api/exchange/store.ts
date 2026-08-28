/**
 * app/api/exchange/store.ts
 *
 * The server half of the commit-encrypt-pay-reveal exchange (Feature 3). It
 * owns the database; every cryptographic decision is deferred to the
 * isomorphic core in lib/exchange.ts, which the client runs to build and sign
 * the exact leaves this module verifies.
 *
 * The invariant this file keeps: the server stores COMMITMENTS, SIGNATURES and
 * STATE TRANSITIONS, and never the dataset, the DEK, or any exact figure. It
 * verifies each posted event's signature, its place in the hash-linked chain,
 * and the legality of its state transition before it writes a row. It cannot
 * forge a step (it holds no signing key) and it refuses a step signed by any
 * key other than the one the acting role pinned at their first event.
 *
 * The one demo affordance is demo_ciphertext: an opaque, size-capped AEAD blob
 * the server treats as bytes it cannot read, so the whole flow is testable end
 * to end. In production the ciphertext moves off the platform and that column
 * stays null.
 */

import type { Client, InArgs } from "@libsql/client";
// Relative .ts imports (not "@/") so plain node scripts (scripts/seed.ts stands
// up a demo session through these real functions) can import this module, the
// same convention as app/api/threads/store.ts and app/api/voprf/server.ts.
import { getDb, now } from "../../../lib/db.ts";
import {
  EXCHANGE_VERSION,
  GENESIS_PREV_HASH,
  MAX_DEMO_BLOB_B64,
  eventHash as computeEventHash,
  isSessionId,
  isSigningPubkey,
  isValidLeafData,
  isValidWireData,
  resolveTransition,
  resolveWireTransition,
  verifyLeafSignature,
  wireStatusFrom,
  type ExchangeLeaf,
  type ExchangeRole,
  type ExchangeState,
  type ExchangeEventType,
  type StoredEvent,
  type StoredWireEvent,
  type WireClaimLeaf,
  type WireClaimType,
  type WireStatus,
} from "../../../lib/exchange.ts";
import type { SessionView } from "../../../components/exchange/types.ts";

export type { SessionView };

/* ------------------------------------------------------------------ types */

/** A posted, signed event as the client sends it and the server re-verifies it. */
export type SignedEventInput = {
  leaf: ExchangeLeaf;
  eventHash: string;
  signature: string;
  signerPubkey: string;
};

export type ExchangeError =
  | "not_participant"
  | "not_confirmed"
  | "buyer_not_confirmed"
  | "buyer_same_as_seller"
  | "unknown_buyer"
  | "bad_session_id"
  | "session_exists"
  | "bad_leaf"
  | "bad_wire"
  | "bad_signature"
  | "chain_conflict"
  | "illegal_transition"
  | "commitment_mismatch"
  | "wire_not_observed"
  | "wrong_signer"
  | "not_found"
  | "terminal";

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: ExchangeError; detail?: string };
export type Result<T> = Ok<T> | Err;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (error: ExchangeError, detail?: string): Err => ({ ok: false, error, detail });

/** The HTTP status each typed error maps to. not_participant is 404, so a
 * session the caller is not on is indistinguishable from one that does not
 * exist, the same policy the deal and thread pages use. */
export function httpStatusFor(error: ExchangeError): number {
  switch (error) {
    case "not_found":
    case "not_participant":
      return 404;
    case "session_exists":
    case "chain_conflict":
    case "wire_not_observed":
    case "terminal":
      return 409;
    case "not_confirmed":
    case "buyer_not_confirmed":
    case "buyer_same_as_seller":
    case "unknown_buyer":
      return 403;
    default:
      return 400;
  }
}

const MAX_ABORT_REASON = 200;

/* ------------------------------------------------------------- deal roles */

type Participant = { userId: string; username: string };

/** Confirmed participants of a deal (reporter is auto-confirmed), by username. */
async function confirmedParticipants(db: Client, dealId: string): Promise<Participant[]> {
  const rs = await db.execute({
    sql: `SELECT p.user_id AS user_id, u.username AS username
            FROM deal_participants p
            JOIN users u ON u.id = p.user_id
           WHERE p.deal_id = ? AND p.status = 'confirmed'`,
    args: [dealId],
  });
  return rs.rows.map((r) => ({ userId: String(r.user_id), username: String(r.username) }));
}

/* ------------------------------------------------------------ row mapping */

type SessionRow = {
  id: string;
  deal_id: string;
  seller_user_id: string;
  buyer_user_id: string;
  seller_signing_pubkey: string;
  buyer_signing_pubkey: string | null;
  state: ExchangeState;
  plaintext_root: string;
  ciphertext_root: string;
  dek_commit: string;
  chunk_count: number;
  chunk_size: number;
  size_bucket: string;
  head_seq: number;
  head_hash: string;
  demo_ciphertext: string | null;
  created_at: number;
  updated_at: number;
};

function toSessionRow(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r.id),
    deal_id: String(r.deal_id),
    seller_user_id: String(r.seller_user_id),
    buyer_user_id: String(r.buyer_user_id),
    seller_signing_pubkey: String(r.seller_signing_pubkey),
    buyer_signing_pubkey: r.buyer_signing_pubkey == null ? null : String(r.buyer_signing_pubkey),
    state: String(r.state) as ExchangeState,
    plaintext_root: String(r.plaintext_root),
    ciphertext_root: String(r.ciphertext_root),
    dek_commit: String(r.dek_commit),
    chunk_count: Number(r.chunk_count),
    chunk_size: Number(r.chunk_size),
    size_bucket: String(r.size_bucket),
    head_seq: Number(r.head_seq),
    head_hash: String(r.head_hash),
    demo_ciphertext: r.demo_ciphertext == null ? null : String(r.demo_ciphertext),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

async function loadSession(db: Client, id: string): Promise<SessionRow | null> {
  const rs = await db.execute({ sql: `SELECT * FROM exchange_sessions WHERE id = ?`, args: [id] });
  return rs.rows[0] ? toSessionRow(rs.rows[0] as Record<string, unknown>) : null;
}

async function loadEvents(db: Client, sessionId: string): Promise<StoredEvent[]> {
  const rs = await db.execute({
    sql: `SELECT seq, type, actor_role, actor_user_id, prev_hash, payload_json,
                 event_hash, signer_pubkey, signature
            FROM exchange_events WHERE session_id = ? ORDER BY seq ASC`,
    args: [sessionId],
  });
  return rs.rows.map((r) => {
    const leaf = JSON.parse(String(r.payload_json)) as ExchangeLeaf;
    return {
      seq: Number(r.seq),
      type: String(r.type) as ExchangeEventType,
      actorRole: String(r.actor_role) as ExchangeRole,
      actor: leaf.actor,
      prevHash: String(r.prev_hash),
      ts: leaf.ts,
      data: leaf.data,
      eventHash: String(r.event_hash),
      signerPubkey: String(r.signer_pubkey),
      signature: String(r.signature),
    };
  });
}

async function loadWireEvents(db: Client, sessionId: string): Promise<StoredWireEvent[]> {
  const rs = await db.execute({
    sql: `SELECT seq, type, actor_role, actor_user_id, prev_hash, payload_json,
                 event_hash, signer_pubkey, signature
            FROM exchange_wire_claims WHERE session_id = ? ORDER BY seq ASC`,
    args: [sessionId],
  });
  return rs.rows.map((r) => {
    const leaf = JSON.parse(String(r.payload_json)) as WireClaimLeaf;
    return {
      seq: Number(r.seq),
      type: String(r.type) as WireClaimType,
      actorRole: String(r.actor_role) as ExchangeRole,
      actor: leaf.actor,
      prevHash: String(r.prev_hash),
      ts: leaf.ts,
      data: leaf.data,
      eventHash: String(r.event_hash),
      signerPubkey: String(r.signer_pubkey),
      signature: String(r.signature),
    };
  });
}

/** The N15 wire reference the seller committed in the genesis commit, or null (legacy). */
function n15FromEvents(events: StoredEvent[]): string | null {
  const commit = events.find((e) => e.type === "commit");
  const n15 = commit?.data?.n15;
  return typeof n15 === "string" && n15.length > 0 ? n15 : null;
}

/** The payment_signaled event's hash: the anchor the wire claim chain hangs off. */
function paymentSignaledHash(events: StoredEvent[]): string | null {
  const pay = events.find((e) => e.type === "payment_signaled");
  return pay ? pay.eventHash : null;
}

async function buildView(db: Client, s: SessionRow, viewerId: string): Promise<SessionView | null> {
  const role: ExchangeRole | null =
    viewerId === s.seller_user_id ? "seller" : viewerId === s.buyer_user_id ? "buyer" : null;
  if (!role) return null;
  const [sellerName, buyerName] = await Promise.all([
    usernameOf(db, s.seller_user_id),
    usernameOf(db, s.buyer_user_id),
  ]);
  const [events, wireEvents] = await Promise.all([
    loadEvents(db, s.id),
    loadWireEvents(db, s.id),
  ]);
  return {
    id: s.id,
    dealId: s.deal_id,
    state: s.state,
    seller: sellerName,
    buyer: buyerName,
    sellerSigningPubkey: s.seller_signing_pubkey,
    buyerSigningPubkey: s.buyer_signing_pubkey,
    yourRole: role,
    chunkCount: s.chunk_count,
    chunkSize: s.chunk_size,
    sizeBucket: s.size_bucket,
    plaintextRoot: s.plaintext_root,
    ciphertextRoot: s.ciphertext_root,
    dekCommit: s.dek_commit,
    headSeq: s.head_seq,
    headHash: s.head_hash,
    hasDemoBlob: s.demo_ciphertext != null,
    demoBlobLen: s.demo_ciphertext ? s.demo_ciphertext.length : 0,
    events,
    n15: n15FromEvents(events),
    wireStatus: wireStatusFrom(wireEvents),
    wireAnchorHash: paymentSignaledHash(events),
    wireEvents,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

async function usernameOf(db: Client, userId: string): Promise<string> {
  const rs = await db.execute({ sql: `SELECT username FROM users WHERE id = ?`, args: [userId] });
  return rs.rows[0] ? String(rs.rows[0].username) : "";
}

/**
 * The account's registered Ed25519 signing key (the identity directory that the
 * receipt path also uses), or null for an account that has not registered one.
 * When present, an exchange step MUST be signed with it, so a step cannot be
 * signed by a key that is not the acting account's own identity key. When
 * absent (a legacy account), the session pins whatever key is first used,
 * trust-on-first-use.
 */
async function registeredSigningKey(db: Client, userId: string): Promise<string | null> {
  const rs = await db.execute({
    sql: `SELECT pubkey FROM user_signing_keys WHERE user_id = ?`,
    args: [userId],
  });
  return rs.rows[0] ? String(rs.rows[0].pubkey) : null;
}

/* ------------------------------------------------------- leaf validation */

/** Shape-check the posted leaf against a role and its stated identity. */
function leafShapeOk(
  leaf: unknown,
  expect: { sessionId?: string; dealId?: string; actor: string; role: ExchangeRole },
): leaf is ExchangeLeaf {
  if (leaf === null || typeof leaf !== "object") return false;
  const l = leaf as Record<string, unknown>;
  if (l.v !== EXCHANGE_VERSION) return false;
  if (!isSessionId(l.sessionId)) return false;
  if (expect.sessionId && l.sessionId !== expect.sessionId) return false;
  if (typeof l.dealId !== "string" || l.dealId.length === 0) return false;
  if (expect.dealId && l.dealId !== expect.dealId) return false;
  if (typeof l.seq !== "number" || !Number.isInteger(l.seq) || l.seq < 1) return false;
  if (typeof l.type !== "string") return false;
  if (l.actorRole !== expect.role) return false;
  if (l.actor !== expect.actor) return false;
  if (typeof l.prevHash !== "string") return false;
  if (typeof l.ts !== "number") return false;
  if (!isValidLeafData(l.type as ExchangeEventType, l.data)) return false;
  return true;
}

/** Verify hash + signature of a posted event against its stated pubkey. */
function signatureOk(input: SignedEventInput): boolean {
  if (computeEventHash(input.leaf) !== input.eventHash) return false;
  if (!isSigningPubkey(input.signerPubkey)) return false;
  return verifyLeafSignature(input.leaf, input.signature, input.signerPubkey);
}

/** The commitment cross-check a step's data must satisfy against the session. */
function commitmentOk(type: ExchangeEventType, data: Record<string, unknown>, s: SessionRow): boolean {
  switch (type) {
    case "ciphertext_ack":
      return data.ciphertextRoot === s.ciphertext_root;
    case "dek_revealed":
      return data.dekCommit === s.dek_commit;
    case "completed":
      return data.plaintextRoot === s.plaintext_root;
    case "payment_signaled":
      return true;
    case "abort":
      return typeof data.reason === "string" && (data.reason as string).length <= MAX_ABORT_REASON;
    case "commit":
      return false; // never appended after genesis
  }
}

/* --------------------------------------------------------------- create */

/**
 * Open a session with its genesis commit. `seller` is the authenticated user;
 * the buyer is named in the signed leaf's data and must be a distinct confirmed
 * participant of the same deal. Everything the server stores is read from the
 * seller-signed leaf, so the seller cannot be committed to something they did
 * not sign.
 */
export async function createExchangeSession(
  seller: { id: string; username: string },
  input: SignedEventInput,
): Promise<Result<SessionView>> {
  const db = await getDb();
  const leaf = input.leaf;
  if (!leafShapeOk(leaf, { actor: seller.username, role: "seller" })) return err("bad_leaf");
  if (leaf.type !== "commit" || leaf.seq !== 1 || leaf.prevHash !== GENESIS_PREV_HASH) {
    return err("bad_leaf", "genesis must be a seq-1 commit with the genesis prev hash");
  }
  if (!isSessionId(leaf.sessionId)) return err("bad_session_id");
  if (!signatureOk(input)) return err("bad_signature");

  const dealId = leaf.dealId;
  const confirmed = await confirmedParticipants(db, dealId);
  const sellerRow = confirmed.find((p) => p.userId === seller.id);
  if (!sellerRow) return err("not_confirmed", "you must be a confirmed participant of this deal");
  const buyerUsername = String(leaf.data.buyer);
  if (buyerUsername === seller.username) return err("buyer_same_as_seller");
  const buyerRow = confirmed.find((p) => p.username === buyerUsername);
  if (!buyerRow) return err("buyer_not_confirmed", "the buyer must be a confirmed participant");

  // Bind the signature to the seller's registered identity key, if they have one.
  const sellerRegistered = await registeredSigningKey(db, seller.id);
  if (sellerRegistered && sellerRegistered !== input.signerPubkey) {
    return err("wrong_signer", "commit not signed with your registered signing key");
  }

  const d = leaf.data;
  const t = now();
  const tx = await db.transaction("write");
  try {
    const exists = await tx.execute({
      sql: `SELECT 1 FROM exchange_sessions WHERE id = ?`,
      args: [leaf.sessionId],
    });
    if (exists.rows.length > 0) {
      await tx.rollback();
      return err("session_exists");
    }
    const sessionArgs: InArgs = [
      leaf.sessionId,
      dealId,
      seller.id,
      buyerRow.userId,
      input.signerPubkey,
      "committed",
      String(d.plaintextRoot),
      String(d.ciphertextRoot),
      String(d.dekCommit),
      Number(d.chunkCount),
      Number(d.chunkSize),
      String(d.sizeBucket),
      1,
      input.eventHash,
      t,
      t,
    ];
    await tx.execute({
      sql: `INSERT INTO exchange_sessions
              (id, deal_id, seller_user_id, buyer_user_id, seller_signing_pubkey,
               state, plaintext_root, ciphertext_root, dek_commit,
               chunk_count, chunk_size, size_bucket, head_seq, head_hash,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: sessionArgs,
    });
    await insertEvent(tx, leaf.sessionId, seller.id, input);
    await tx.commit();
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      /* already closed */
    }
    throw e;
  } finally {
    tx.close();
  }

  const s = await loadSession(db, leaf.sessionId);
  if (!s) return err("not_found");
  const view = await buildView(db, s, seller.id);
  return view ? ok(view) : err("not_participant");
}

/* --------------------------------------------------------------- append */

/**
 * Append the next signed event. Everything is re-verified server-side: the
 * leaf's identity, its place in the chain (seq and prev hash against the tip
 * the appender must have seen), the signature, the commitment cross-check, the
 * legality of the state transition for the acting role, and the pinned-key
 * rule (a role's every event must carry the key it pinned at its first event).
 */
export async function appendExchangeEvent(
  user: { id: string; username: string },
  sessionId: string,
  input: SignedEventInput,
): Promise<Result<SessionView>> {
  const db = await getDb();
  const pre = await loadSession(db, sessionId);
  if (!pre) return err("not_found");
  const role: ExchangeRole | null =
    user.id === pre.seller_user_id ? "seller" : user.id === pre.buyer_user_id ? "buyer" : null;
  if (!role) return err("not_participant");

  const leaf = input.leaf;
  if (!leafShapeOk(leaf, { sessionId, dealId: pre.deal_id, actor: user.username, role })) {
    return err("bad_leaf");
  }
  if (leaf.type === "commit") return err("bad_leaf", "commit is the genesis event only");
  if (!signatureOk(input)) return err("bad_signature");
  if (!commitmentOk(leaf.type, leaf.data, pre)) return err("commitment_mismatch");

  // Bind the signature to the actor's registered identity key, if they have one,
  // so a step cannot be signed by a key that is not this account's own.
  const registered = await registeredSigningKey(db, user.id);
  if (registered && registered !== input.signerPubkey) {
    return err("wrong_signer", "not signed with your registered signing key");
  }

  const t = now();
  const tx = await db.transaction("write");
  try {
    // Re-read the tip inside the write lock: the compare-and-set that makes a
    // concurrent second post conflict instead of forking the chain.
    const cur = await loadSessionTx(tx, sessionId);
    if (!cur) {
      await tx.rollback();
      return err("not_found");
    }
    if (leaf.seq !== cur.head_seq + 1 || leaf.prevHash !== cur.head_hash) {
      await tx.rollback();
      return err("chain_conflict", `expected seq ${cur.head_seq + 1} on tip ${cur.head_hash}`);
    }
    const transition = resolveTransition(cur.state, leaf.type, role);
    if (!transition.ok) {
      await tx.rollback();
      return transition.error === "terminal"
        ? err("terminal")
        : err("illegal_transition", transition.error);
    }
    // The pay-step gate (Feature 1): the seller may only reveal the key once the
    // WireCreditClaim reached wire_credit_observed (a countersigned, un-reversed
    // credit). Before that, the payment is at most the buyer's sent-commit, which
    // is not enough to release the data.
    if (leaf.type === "dek_revealed") {
      const wireEvents = await loadWireEventsTx(tx, sessionId);
      if (wireStatusFrom(wireEvents) !== "observed") {
        await tx.rollback();
        return err("wire_not_observed", "reveal is gated on a countersigned wire-credit observation");
      }
    }
    // Pinned-key rule: a role signs every step with the key it first used.
    if (role === "seller") {
      if (input.signerPubkey !== cur.seller_signing_pubkey) {
        await tx.rollback();
        return err("wrong_signer", "seller key differs from the one pinned at commit");
      }
    } else {
      if (cur.buyer_signing_pubkey && input.signerPubkey !== cur.buyer_signing_pubkey) {
        await tx.rollback();
        return err("wrong_signer", "buyer key differs from the one pinned at first step");
      }
    }

    await insertEvent(tx, sessionId, user.id, input);
    const pinBuyer = role === "buyer" && !cur.buyer_signing_pubkey;
    await tx.execute({
      sql: `UPDATE exchange_sessions
               SET state = ?, head_seq = ?, head_hash = ?, updated_at = ?
                   ${pinBuyer ? ", buyer_signing_pubkey = ?" : ""}
             WHERE id = ? AND head_seq = ?`,
      args: pinBuyer
        ? [transition.to, leaf.seq, input.eventHash, t, input.signerPubkey, sessionId, cur.head_seq]
        : [transition.to, leaf.seq, input.eventHash, t, sessionId, cur.head_seq],
    });
    await tx.commit();
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      /* already closed */
    }
    throw e;
  } finally {
    tx.close();
  }

  const s = await loadSession(db, sessionId);
  if (!s) return err("not_found");
  const view = await buildView(db, s, user.id);
  return view ? ok(view) : err("not_participant");
}

type TxLike = { execute(stmt: { sql: string; args: InArgs }): Promise<{ rows: unknown[] }> };

async function loadSessionTx(tx: TxLike, id: string): Promise<SessionRow | null> {
  const rs = await tx.execute({ sql: `SELECT * FROM exchange_sessions WHERE id = ?`, args: [id] });
  return rs.rows[0] ? toSessionRow(rs.rows[0] as Record<string, unknown>) : null;
}

async function insertEvent(
  tx: TxLike,
  sessionId: string,
  actorUserId: string,
  input: SignedEventInput,
): Promise<void> {
  const leaf = input.leaf;
  await tx.execute({
    sql: `INSERT INTO exchange_events
            (session_id, seq, type, actor_role, actor_user_id, prev_hash,
             payload_json, event_hash, signer_pubkey, signature, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      sessionId,
      leaf.seq,
      leaf.type,
      leaf.actorRole,
      actorUserId,
      leaf.prevHash,
      JSON.stringify(leaf),
      input.eventHash,
      input.signerPubkey,
      input.signature,
      now(),
    ],
  });
}

/* ------------------------------------------------------- wire credit claim */

/** Shape-check a posted WireCreditClaim leaf against a role and its identity. */
function wireLeafShapeOk(
  leaf: unknown,
  expect: { sessionId: string; dealId: string; actor: string; role: ExchangeRole },
): leaf is WireClaimLeaf {
  if (leaf === null || typeof leaf !== "object") return false;
  const l = leaf as Record<string, unknown>;
  if (l.v !== EXCHANGE_VERSION) return false;
  if (!isSessionId(l.sessionId) || l.sessionId !== expect.sessionId) return false;
  if (typeof l.dealId !== "string" || l.dealId !== expect.dealId) return false;
  if (typeof l.seq !== "number" || !Number.isInteger(l.seq) || l.seq < 1) return false;
  if (
    l.type !== "wire_credit_claim" &&
    l.type !== "wire_credit_countersign" &&
    l.type !== "wire_reversed"
  ) {
    return false;
  }
  if (l.actorRole !== expect.role) return false;
  if (l.actor !== expect.actor) return false;
  if (typeof l.prevHash !== "string") return false;
  if (typeof l.ts !== "number") return false;
  if (!isValidWireData(l.type as WireClaimType, l.data)) return false;
  return true;
}

async function loadWireEventsTx(tx: TxLike, sessionId: string): Promise<StoredWireEvent[]> {
  const rs = await tx.execute({
    sql: `SELECT seq, type, actor_role, actor_user_id, prev_hash, payload_json,
                 event_hash, signer_pubkey, signature
            FROM exchange_wire_claims WHERE session_id = ? ORDER BY seq ASC`,
    args: [sessionId],
  });
  return (rs.rows as Record<string, unknown>[]).map((r) => {
    const leaf = JSON.parse(String(r.payload_json)) as WireClaimLeaf;
    return {
      seq: Number(r.seq),
      type: String(r.type) as WireClaimType,
      actorRole: String(r.actor_role) as ExchangeRole,
      actor: leaf.actor,
      prevHash: String(r.prev_hash),
      ts: leaf.ts,
      data: leaf.data,
      eventHash: String(r.event_hash),
      signerPubkey: String(r.signer_pubkey),
      signature: String(r.signature),
    };
  });
}

/** The payment_signaled event's hash inside the write lock: the wire anchor. */
async function paymentSignaledHashTx(tx: TxLike, sessionId: string): Promise<string | null> {
  const rs = await tx.execute({
    sql: `SELECT event_hash FROM exchange_events
           WHERE session_id = ? AND type = 'payment_signaled'
           ORDER BY seq DESC LIMIT 1`,
    args: [sessionId],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  return row ? String(row.event_hash) : null;
}

/** The N15 reference the seller committed in the genesis commit, inside the lock. */
async function sessionN15Tx(tx: TxLike, sessionId: string): Promise<string | null> {
  const rs = await tx.execute({
    sql: `SELECT payload_json FROM exchange_events WHERE session_id = ? AND seq = 1`,
    args: [sessionId],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  try {
    const leaf = JSON.parse(String(row.payload_json)) as WireClaimLeaf;
    const n15 = leaf.data?.n15;
    return typeof n15 === "string" && n15.length > 0 ? n15 : null;
  } catch {
    return null;
  }
}

async function insertWireEvent(
  tx: TxLike,
  sessionId: string,
  actorUserId: string,
  input: SignedEventInput,
): Promise<void> {
  const leaf = input.leaf;
  await tx.execute({
    sql: `INSERT INTO exchange_wire_claims
            (session_id, seq, type, actor_role, actor_user_id, prev_hash,
             payload_json, event_hash, signer_pubkey, signature, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      sessionId,
      leaf.seq,
      leaf.type,
      leaf.actorRole,
      actorUserId,
      leaf.prevHash,
      JSON.stringify(leaf),
      input.eventHash,
      input.signerPubkey,
      input.signature,
      now(),
    ],
  });
}

/**
 * Append the next WireCreditClaim step (Feature 1). It is the payment phase of
 * the exchange, three-party and mutually signed: the seller claims an observed
 * inbound credit, the buyer countersigns, and only then (see the dek_revealed
 * gate in appendExchangeEvent) may the seller release the key. A later
 * wire_reversed reopens the deal. Everything is re-verified server-side: the
 * leaf's identity and shape, its Ed25519 signature, its place in the wire chain
 * (anchored to the payment_signaled event), the N15 and claim-hash bindings, the
 * wire sub-state transition for the acting role, and the pinned-key rule. The
 * server stores commitments and signatures only, never the bank record.
 */
export async function appendWireClaim(
  user: { id: string; username: string },
  sessionId: string,
  input: SignedEventInput,
): Promise<Result<SessionView>> {
  const db = await getDb();
  const pre = await loadSession(db, sessionId);
  if (!pre) return err("not_found");
  const role: ExchangeRole | null =
    user.id === pre.seller_user_id ? "seller" : user.id === pre.buyer_user_id ? "buyer" : null;
  if (!role) return err("not_participant");

  const raw: unknown = input.leaf;
  if (!wireLeafShapeOk(raw, { sessionId, dealId: pre.deal_id, actor: user.username, role })) {
    return err("bad_wire");
  }
  const leaf = raw;
  if (!signatureOk(input)) return err("bad_signature");

  const registered = await registeredSigningKey(db, user.id);
  if (registered && registered !== input.signerPubkey) {
    return err("wrong_signer", "not signed with your registered signing key");
  }

  const t = now();
  const tx = await db.transaction("write");
  try {
    const cur = await loadSessionTx(tx, sessionId);
    if (!cur) {
      await tx.rollback();
      return err("not_found");
    }

    const anchor = await paymentSignaledHashTx(tx, sessionId);
    if (!anchor) {
      await tx.rollback();
      return err("illegal_transition", "no payment has been sent to claim against");
    }
    // Claim and countersign run in the payment phase; a reversal is legal later
    // too (a credit can be clawed back after delivery), but only once observed.
    if (leaf.type === "wire_reversed") {
      if (
        cur.state !== "payment_signaled" &&
        cur.state !== "dek_revealed" &&
        cur.state !== "completed"
      ) {
        await tx.rollback();
        return err("illegal_transition", "nothing to reverse in this state");
      }
    } else if (cur.state !== "payment_signaled") {
      await tx.rollback();
      return err("illegal_transition", "wire steps run in the payment phase");
    }

    const wireEvents = await loadWireEventsTx(tx, sessionId);
    const status = wireStatusFrom(wireEvents);
    const transition = resolveWireTransition(status, leaf.type, role);
    if (!transition.ok) {
      await tx.rollback();
      return transition.error === "wrong_role"
        ? err("wrong_signer", "this wire step is the other party's to sign")
        : err("illegal_transition", transition.error);
    }

    // Chain position: 1-based on the wire chain, seq 1 anchored to the
    // payment_signaled hash, later ones to the prior wire event.
    const expectedSeq = wireEvents.length + 1;
    const tipHash = wireEvents.length === 0 ? anchor : wireEvents[wireEvents.length - 1].eventHash;
    if (leaf.seq !== expectedSeq || leaf.prevHash !== tipHash) {
      await tx.rollback();
      return err("chain_conflict", `expected seq ${expectedSeq} on tip ${tipHash}`);
    }

    // Commitment cross-checks: the reference every claim/countersign names must
    // be the committed N15, and every countersign/reversal must name the exact
    // claim it acts on.
    if (leaf.type === "wire_credit_claim" || leaf.type === "wire_credit_countersign") {
      const n15 = await sessionN15Tx(tx, sessionId);
      if (n15 == null || String(leaf.data.n15) !== n15) {
        await tx.rollback();
        return err("commitment_mismatch", "n15 differs from the committed wire reference");
      }
    }
    if (leaf.type === "wire_credit_countersign" || leaf.type === "wire_reversed") {
      const lastClaim = [...wireEvents].reverse().find((e) => e.type === "wire_credit_claim");
      if (!lastClaim || String(leaf.data.claimHash) !== lastClaim.eventHash) {
        await tx.rollback();
        return err("commitment_mismatch", "claim hash does not match the observed claim");
      }
    }

    // Pinned-key rule, the same as the exchange chain: a role signs every step
    // with the key it pinned at its first exchange event.
    if (role === "seller") {
      if (input.signerPubkey !== cur.seller_signing_pubkey) {
        await tx.rollback();
        return err("wrong_signer", "seller key differs from the one pinned at commit");
      }
    } else if (cur.buyer_signing_pubkey && input.signerPubkey !== cur.buyer_signing_pubkey) {
      await tx.rollback();
      return err("wrong_signer", "buyer key differs from the one pinned earlier");
    }

    try {
      await insertWireEvent(tx, sessionId, user.id, input);
    } catch (e) {
      // A concurrent post took this seq: the (session_id, seq) primary key makes
      // the race a conflict, not a fork.
      await tx.rollback();
      if (String(e).includes("exchange_wire_claims") || String(e).toUpperCase().includes("UNIQUE")) {
        return err("chain_conflict", "a concurrent wire step took this position");
      }
      throw e;
    }
    await tx.execute({
      sql: `UPDATE exchange_sessions SET updated_at = ? WHERE id = ?`,
      args: [t, sessionId],
    });
    await tx.commit();
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      /* already closed */
    }
    throw e;
  } finally {
    tx.close();
  }

  const s = await loadSession(db, sessionId);
  if (!s) return err("not_found");
  const view = await buildView(db, s, user.id);
  return view ? ok(view) : err("not_participant");
}

/* ----------------------------------------------------------------- reads */

export async function getSessionView(sessionId: string, userId: string): Promise<SessionView | null> {
  const db = await getDb();
  const s = await loadSession(db, sessionId);
  if (!s) return null;
  return buildView(db, s, userId);
}

/** The most recent session on a deal the user is part of, for the deal page. */
export async function latestSessionForDeal(dealId: string, userId: string): Promise<SessionView | null> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT id FROM exchange_sessions
           WHERE deal_id = ? AND (seller_user_id = ? OR buyer_user_id = ?)
           ORDER BY created_at DESC LIMIT 1`,
    args: [dealId, userId, userId],
  });
  if (!rs.rows[0]) return null;
  return getSessionView(String(rs.rows[0].id), userId);
}

/* ------------------------------------------------------- demo ciphertext */

/**
 * Store the opaque ciphertext blob for the demo path. Seller only, size-capped.
 * The server never reads it; it is bytes the buyer verifies against the
 * committed ciphertext root. Returns the stored length.
 */
export async function setDemoBlob(
  sessionId: string,
  sellerUserId: string,
  ciphertextB64: string,
): Promise<Result<{ length: number }>> {
  if (typeof ciphertextB64 !== "string" || ciphertextB64.length === 0) return err("bad_leaf");
  if (ciphertextB64.length > MAX_DEMO_BLOB_B64) return err("bad_leaf", "ciphertext blob too large");
  if (!/^[A-Za-z0-9_-]+$/.test(ciphertextB64)) return err("bad_leaf", "expected base64url ciphertext");
  const db = await getDb();
  const s = await loadSession(db, sessionId);
  if (!s) return err("not_found");
  if (s.seller_user_id !== sellerUserId) return err("not_participant", "only the seller uploads ciphertext");
  await db.execute({
    sql: `UPDATE exchange_sessions SET demo_ciphertext = ?, updated_at = ? WHERE id = ?`,
    args: [ciphertextB64, now(), sessionId],
  });
  return ok({ length: ciphertextB64.length });
}

/** Read the opaque demo ciphertext blob. Either participant may fetch it. */
export async function getDemoBlob(sessionId: string, userId: string): Promise<Result<string | null>> {
  const db = await getDb();
  const s = await loadSession(db, sessionId);
  if (!s) return err("not_found");
  if (s.seller_user_id !== userId && s.buyer_user_id !== userId) return err("not_participant");
  return ok(s.demo_ciphertext);
}
