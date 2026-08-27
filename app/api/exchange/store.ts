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
  resolveTransition,
  verifyLeafSignature,
  type ExchangeLeaf,
  type ExchangeRole,
  type ExchangeState,
  type ExchangeEventType,
  type StoredEvent,
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
  | "bad_signature"
  | "chain_conflict"
  | "illegal_transition"
  | "commitment_mismatch"
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

async function buildView(db: Client, s: SessionRow, viewerId: string): Promise<SessionView | null> {
  const role: ExchangeRole | null =
    viewerId === s.seller_user_id ? "seller" : viewerId === s.buyer_user_id ? "buyer" : null;
  if (!role) return null;
  const [sellerName, buyerName] = await Promise.all([
    usernameOf(db, s.seller_user_id),
    usernameOf(db, s.buyer_user_id),
  ]);
  const events = await loadEvents(db, s.id);
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
