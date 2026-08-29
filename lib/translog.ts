/**
 * lib/translog.ts
 *
 * The append-only Merkle transparency log, server side. Certificate
 * Transparency / sigsum, scaled to one board: every consequential, non-PII
 * event becomes a canonical leaf in an RFC 6962 tree; the tree head is signed
 * with an Ed25519 key; and anyone can be handed a proof that a leaf is in the
 * tree (inclusion) and that an earlier tree is a prefix of a later one
 * (consistency, i.e. nothing was rewritten, only appended).
 *
 * The Merkle math and proof/STH VERIFICATION live in lib/merkle.ts, which is
 * isomorphic so the browser runs the identical code. This module is the
 * server half: it owns the database, blinds subject ids, allocates sequence
 * numbers, signs heads with the pepper-derived key, and generates proofs.
 *
 * WHAT A LEAF IS. Canonical JSON of { seq, type, ts, subject, ...bucketed }.
 *   - `subject` is HMAC(SERVER_PEPPER, "translog-subject" | raw id): a blinded
 *     row id. Never a handle, never a buyer name, never a contact.
 *   - dollar amounts appear only as $10k buckets ("$120k", "<$10k").
 *   - `seq` is the 1-based position, so the leaf is self-locating and no two
 *     leaves can share a hash.
 * The leaf hash is SHA-256(0x00 || canonical bytes), the RFC 6962 leaf hash.
 *
 * HONEST BOUNDARY, stated here and on /transparency/log. The log key is
 * HMAC-derived from SERVER_PEPPER, so the OPERATOR CAN SIGN A FORK of the log.
 * What the design buys is not impossibility of a fork but DETECTABILITY of a
 * rewrite: consistency proofs plus the external git anchor
 * (docs/transparency-log/, committed by CI) mean that rewriting history others
 * have already pulled, or serving two forks, is caught after the fact. The
 * real upgrade (independent witnesses co-signing STHs; a TEE-held log key) is
 * future work, and is labeled as such. Everything logged is metadata only.
 */

import type { InStatement, ResultSet } from "@libsql/client";
import { hkdfSync } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { getDb, now } from "./db.ts";
import { serverPepper, hmacHex, sha256Hex } from "./crypto.ts";
import { usdRounded10k } from "../components/deals/format.ts";
import {
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  canonicalJson,
  leafHashHex,
  merkleRootHex,
  inclusionProofHex,
  consistencyProofHex,
  sthSigningBody,
  type Sth,
} from "./merkle.ts";
import {
  receiptPayloadForDeal,
  encodeReceipt,
  type ReceiptPayload,
} from "./receipts.ts";
import { attestationForDeal } from "./party-sigs.ts";
import type { DealDetail } from "./deals.ts";
import {
  verifyCosignature,
  checkQuorum,
  type WitnessCosignature,
  type WitnessedSth,
} from "./witness.ts";
import { recognizedWitnesses, witnessQuorumN } from "./witnesses.ts";

/* --------------------------------------------------------------- log key */

/** HKDF info label for the log's Ed25519 key. Rotating the pepper rotates it. */
export const TRANSLOG_HKDF_LABEL = "databoard-translog-v1";
/** STH format version. Bump only on a breaking head-shape change. */
export const STH_VERSION = 1 as const;
/** Domain separator for blinding a subject id into a leaf. */
const SUBJECT_DOMAIN = "translog-subject";

/**
 * The 32-byte Ed25519 seed: HKDF-SHA256 over SERVER_PEPPER, salt "databoard",
 * info "databoard-translog-v1". A pure function of the pepper, exactly like
 * the VOPRF key (lib/crypto.ts), which is the property that makes the log key
 * reproducible and the "operator can fork" caveat honest.
 */
function logSecretSeed(): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", serverPepper(), "databoard", TRANSLOG_HKDF_LABEL, 32),
  );
}

/** The log's Ed25519 public key, hex. Served at /api/translog/pubkey. */
export function logPublicKeyHex(): string {
  return bytesToHex(ed25519.getPublicKey(logSecretSeed()));
}

/** A stable id for this log instance: SHA-256 of its public key. */
export function logId(): string {
  return sha256Hex(logPublicKeyHex());
}

/* ------------------------------------------------------------- leaf model */

/**
 * The events that become leaves. `subject` is the RAW id (deal/ask/invite/
 * settlement); appendLeaf blinds it before it is written. Bucketed strings
 * ("$120k") are computed by callers or here; nothing raw is ever stored.
 */
export type LeafEvent =
  | { type: "deal_recorded"; subject: string; totalUsd: number; parties: number }
  | { type: "participant_confirmed"; subject: string; tier: string }
  | { type: "deal_tiered"; subject: string; tier: string }
  | { type: "receipt_minted"; subject: string; tier: string; amountBucket: string }
  | { type: "referral_settled"; subject: string; totalUsd: number }
  | { type: "ask_posted"; subject: string; category: string }
  | { type: "ask_closed"; subject: string; reason: string }
  | { type: "invite_consumed"; subject: string }
  // The served-JS integrity manifest itself, as a leaf: the sha256 digest of
  // the manifest served at /api/transparency/js-manifest, plus the build id it
  // describes. This is the manifest CI attests with Sigstore; logging its
  // digest puts the code-integrity claim inside the same witnessed append-only
  // log as the deal ledger, so which JS a deployment vouched for at a commit is
  // as tamper-evident as everything else. All three fields are public,
  // non-PII: a git commit, a build id, and a hash. See scripts/gen-js-manifest.
  | { type: "served_manifest"; subject: string; manifestSha256: string; buildId: string };

/** Build the canonical leaf object (pre-hash) for an event at a sequence. */
function buildLeaf(seq: number, ts: number, event: LeafEvent): Record<string, unknown> {
  const subject = hmacHex(SUBJECT_DOMAIN, event.subject);
  const base = { seq, type: event.type, ts, subject };
  switch (event.type) {
    case "deal_recorded":
      return { ...base, amountBucket: usdRounded10k(event.totalUsd), parties: event.parties };
    case "participant_confirmed":
    case "deal_tiered":
      return { ...base, tier: event.tier };
    case "receipt_minted":
      return { ...base, tier: event.tier, amountBucket: event.amountBucket };
    case "referral_settled":
      return { ...base, amountBucket: usdRounded10k(event.totalUsd) };
    case "ask_posted":
      return { ...base, category: event.category };
    case "ask_closed":
      return { ...base, reason: event.reason };
    case "invite_consumed":
      return base;
    case "served_manifest":
      return { ...base, manifestSha256: event.manifestSha256, buildId: event.buildId };
  }
}

/* ---------------------------------------------------------------- append */

/** Anything with an .execute: the Client, or a Transaction to enlist in. */
type Executor = { execute(stmt: InStatement): Promise<ResultSet> };

export type AppendResult = { seq: number; leafHash: string; deduped: boolean };

/**
 * Append one leaf. Two ways to call it:
 *   - inside a caller's write transaction, by passing { executor: tx }: the
 *     leaf commits atomically with the mutation (used by createDeal and
 *     consumeInvite);
 *   - on its own, opening a short write transaction: used by the post-commit
 *     hooks, which wrap it so a logging failure never breaks a user action.
 *
 * A write transaction (BEGIN IMMEDIATE) holds the writer lock, so reading
 * MAX(seq) and inserting the next row is race-free: sequence numbers stay a
 * contiguous 1..N with no gaps. `dedupKey`, when given, makes the append
 * idempotent: a second call for the same logical event returns the first
 * leaf instead of writing a duplicate.
 */
export async function appendLeaf(
  event: LeafEvent,
  opts: { executor?: Executor; dedupKey?: string } = {},
): Promise<AppendResult> {
  if (opts.executor) return appendWithin(opts.executor, event, opts.dedupKey);
  const db = await getDb();
  const tx = await db.transaction("write");
  try {
    const r = await appendWithin(tx, event, opts.dedupKey);
    await tx.commit();
    return r;
  } finally {
    tx.close();
  }
}

async function appendWithin(
  ex: Executor,
  event: LeafEvent,
  dedupKey?: string,
): Promise<AppendResult> {
  if (dedupKey) {
    const found = await ex.execute({
      sql: `SELECT leaf_seq, leaf_hash FROM translog_events WHERE dedup_key = ?`,
      args: [dedupKey],
    });
    const row = found.rows[0];
    if (row) {
      return { seq: Number(row.leaf_seq), leafHash: String(row.leaf_hash), deduped: true };
    }
  }
  const maxRs = await ex.execute(
    `SELECT COALESCE(MAX(seq), 0) AS m FROM translog_leaves`,
  );
  const seq = Number(maxRs.rows[0]?.m ?? 0) + 1;
  const t = now();
  const payloadJson = canonicalJson(buildLeaf(seq, t, event));
  const leafHash = leafHashHex(utf8ToBytes(payloadJson));
  await ex.execute({
    sql: `INSERT INTO translog_leaves (seq, leaf_hash, payload_json, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [seq, leafHash, payloadJson, t],
  });
  if (dedupKey) {
    await ex.execute({
      sql: `INSERT INTO translog_events (dedup_key, leaf_seq, leaf_hash, created_at)
            VALUES (?, ?, ?, ?) ON CONFLICT(dedup_key) DO NOTHING`,
      args: [dedupKey, seq, leafHash, t],
    });
  }
  return { seq, leafHash, deduped: false };
}

/**
 * Fire-and-forget append for the post-commit hooks. Swallows and logs any
 * error so the transparency log can never fail the mutation it observes. Do
 * NOT use this for the in-transaction appends (there the leaf is meant to be
 * atomic with the write, so an error should roll the whole thing back).
 */
export async function appendLeafBestEffort(
  event: LeafEvent,
  opts: { dedupKey?: string } = {},
): Promise<void> {
  try {
    await appendLeaf(event, opts);
  } catch (err) {
    console.error(`translog: append(${event.type}) failed:`, err);
  }
}

/* ------------------------------------------------ served-manifest binding */

export type ServedManifestLeaf = {
  seq: number;
  leafHash: string;
  manifestSha256: string;
  buildId: string;
  commit: string | null;
};

/**
 * Log the served-JS integrity manifest as a leaf: the sha256 of the exact
 * bytes served at /api/transparency/js-manifest (which is the digest CI
 * attests with Sigstore), together with the build id and commit it describes.
 * This is what makes "the manifest itself is in the witnessed append-only log"
 * true: the code-integrity claim for a deployment becomes as tamper-evident as
 * the deal ledger, so an operator cannot quietly swap which JS it vouched for
 * at a commit without the consistency proof and the external anchors
 * disagreeing.
 *
 * Idempotent per (commit, digest): re-running the deploy hook for the same
 * manifest reuses the one leaf. The subject is HMAC(commit) for structural
 * uniformity with every other leaf; the manifest digest and build id ride as
 * clear fields, since all three are public and non-PII, so an auditor who
 * knows the served manifest's digest can find its leaf by that digest.
 *
 * Pass the RAW manifest bytes (the same string the route serves), not a
 * re-serialized object: the digest must match what an outside verifier
 * computes over the downloaded file. Returns null on a stub/malformed manifest.
 */
export async function logServedManifest(
  manifestJson: string,
): Promise<ServedManifestLeaf | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { files?: unknown }).files)
  ) {
    return null; // a stub or a non-manifest: nothing to vouch for
  }
  const m = parsed as { commit?: unknown; buildId?: unknown };
  const commit = typeof m.commit === "string" ? m.commit : null;
  const buildId =
    typeof m.buildId === "string"
      ? m.buildId
      : (commit ?? "unknown");
  const manifestSha256 = sha256Hex(manifestJson);
  const { seq, leafHash } = await appendLeaf(
    {
      type: "served_manifest",
      subject: commit ?? manifestSha256,
      manifestSha256,
      buildId,
    },
    { dedupKey: `served_manifest:${commit ?? "nocommit"}:${manifestSha256}` },
  );
  return { seq, leafHash, manifestSha256, buildId, commit };
}

/* -------------------------------------------------------------- reading */

async function currentTreeSize(ex: Executor): Promise<number> {
  const rs = await ex.execute(`SELECT COUNT(*) AS n FROM translog_leaves`);
  return Number(rs.rows[0]?.n ?? 0);
}

/** Leaf hashes for seq 1..size, in order. The tree at `size` is exactly these. */
async function leafHashesUpTo(ex: Executor, size: number): Promise<string[]> {
  if (size <= 0) return [];
  const rs = await ex.execute({
    sql: `SELECT leaf_hash FROM translog_leaves WHERE seq <= ? ORDER BY seq ASC`,
    args: [size],
  });
  return rs.rows.map((r) => String(r.leaf_hash));
}

/* ------------------------------------------------------------------ STH */

function signSth(treeSize: number, rootHash: string): Sth {
  const head: Omit<Sth, "signature"> = {
    v: STH_VERSION,
    logId: logId(),
    treeSize,
    rootHash,
    timestamp: now(),
  };
  const sig = ed25519.sign(utf8ToBytes(sthSigningBody(head)), logSecretSeed());
  return { ...head, signature: bytesToHex(sig) };
}

/**
 * The canonical Signed Tree Head at a tree size (default: the current size).
 * The root is a pure function of the leaves, so this caches: the first
 * observer at a size signs and stores the STH; every later observer at that
 * size is handed the identical stored head, so anchors and consistency
 * checks reference stable checkpoints instead of a fresh timestamp each call.
 */
export async function getSignedHead(size?: number): Promise<Sth> {
  const db = await getDb();
  const treeSize = size ?? (await currentTreeSize(db));
  const cached = await db.execute({
    sql: `SELECT signed_head FROM translog_heads WHERE tree_size = ?`,
    args: [treeSize],
  });
  if (cached.rows[0]) return JSON.parse(String(cached.rows[0].signed_head)) as Sth;

  const rootHash = merkleRootHex(await leafHashesUpTo(db, treeSize));
  const sth = signSth(treeSize, rootHash);
  await db.execute({
    sql: `INSERT INTO translog_heads (tree_size, root_hash, signed_head, created_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(tree_size) DO NOTHING`,
    args: [treeSize, rootHash, JSON.stringify(sth), now()],
  });
  // Re-read so a racing writer's head (first to commit) is the one returned:
  // every observer at this size agrees on one STH.
  const after = await db.execute({
    sql: `SELECT signed_head FROM translog_heads WHERE tree_size = ?`,
    args: [treeSize],
  });
  return after.rows[0] ? (JSON.parse(String(after.rows[0].signed_head)) as Sth) : sth;
}

/** The signed checkpoint history: every tree size the log has been observed at. */
export async function listSignedHeads(limit = 50): Promise<Sth[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT signed_head FROM translog_heads ORDER BY tree_size DESC LIMIT ?`,
    args: [limit],
  });
  return rs.rows.map((r) => JSON.parse(String(r.signed_head)) as Sth);
}

/* -------------------------------------------------------------- proofs */

export type InclusionProof = {
  leafHash: string;
  leafIndex: number;
  treeSize: number;
  auditPath: string[];
  rootHash: string;
  sth: Sth;
};

/**
 * An inclusion proof for a leaf hash against the current tree, or null when
 * the hash is not a leaf. The audit path proves the leaf sits at leafIndex in
 * a tree of treeSize leaves whose root the STH signs.
 */
export async function inclusionProofFor(leafHashInput: string): Promise<InclusionProof | null> {
  const leaf = (leafHashInput ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(leaf)) return null;
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT seq FROM translog_leaves WHERE leaf_hash = ?`,
    args: [leaf],
  });
  if (!rs.rows[0]) return null;
  const leafIndex = Number(rs.rows[0].seq) - 1; // seq is 1-based, tree index 0-based
  const treeSize = await currentTreeSize(db);
  const auditPath = inclusionProofHex(leafIndex, await leafHashesUpTo(db, treeSize));
  const sth = await getSignedHead(treeSize);
  return { leafHash: leaf, leafIndex, treeSize, auditPath, rootHash: sth.rootHash, sth };
}

export type ConsistencyProof = {
  first: number;
  second: number;
  firstRoot: string;
  secondRoot: string;
  proof: string[];
  firstSth: Sth;
  secondSth: Sth;
};

/**
 * A consistency proof that the size-`from` tree is a prefix of the size-`to`
 * tree: the append-only witness. Null on out-of-range sizes.
 */
export async function consistencyProofBetween(
  from: number,
  to: number,
): Promise<ConsistencyProof | null> {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  const db = await getDb();
  const size = await currentTreeSize(db);
  if (from < 0 || to < from || to > size) return null;
  const hashes = await leafHashesUpTo(db, to);
  const proof = consistencyProofHex(from, hashes);
  const [firstSth, secondSth] = await Promise.all([
    getSignedHead(from),
    getSignedHead(to),
  ]);
  return {
    first: from,
    second: to,
    firstRoot: merkleRootHex(hashes.slice(0, from)),
    secondRoot: merkleRootHex(hashes),
    proof,
    firstSth,
    secondSth,
  };
}

/* ------------------------------------------------------ receipt binding */

/**
 * Mint a receipt for a deal AND bind it to the log: the returned token carries
 * `log: { seq, leafHash }` for the receipt_minted leaf, so verifying the
 * receipt can go on to prove it sits in the append-only tree at a signed size
 * (the /receipts/verify page does exactly that). Idempotent per deal state:
 * the same tier and attestation reuse one leaf, so the token is stable across
 * renders. Falls back to an unlogged receipt if the log is unreachable, so the
 * deal page never breaks. Null when the deal does not mint (claimed / solo).
 *
 * The token also carries the PARTY-SIGNATURE block (lib/party-sigs.ts): the
 * roster of confirmed participants who hold a signing key, and each signature
 * collected so far, bound to the `seq` of this receipt state. That is what
 * makes a co-attested receipt unforgeable by the operator, who holds no party
 * key. Attaching it needs the seq, so it rides the log-aware path only.
 */
export async function loggedReceiptForDeal(
  deal: DealDetail,
): Promise<{ token: string; payload: ReceiptPayload } | null> {
  const payload = receiptPayloadForDeal(deal);
  if (!payload) return null;
  try {
    const { seq, leafHash } = await appendLeaf(
      {
        type: "receipt_minted",
        subject: deal.id,
        tier: payload.tier,
        amountBucket: payload.amountBucket,
      },
      { dedupKey: `receipt_minted:${deal.id}:${payload.tier}:${payload.attestedAt}` },
    );
    const attest = await attestationForDeal(deal, seq);
    const full: ReceiptPayload = {
      ...payload,
      log: { seq, leafHash },
      ...(attest ? { attest } : {}),
    };
    return { token: encodeReceipt(full), payload: full };
  } catch (err) {
    console.error("translog: loggedReceiptForDeal fell back to unlogged:", err);
    return { token: encodeReceipt(payload), payload };
  }
}

/* --------------------------------------------------- deal state hooks */

/**
 * Log a deal's state after a confirm or an evidence commit: the confirming
 * participant, the tier if it climbed past claimed. Best-effort and
 * idempotent, called from the deal write paths after they commit. The
 * receipt_minted leaf is written lazily by loggedReceiptForDeal when the
 * receipt is actually produced, so it is not duplicated here.
 */
export async function logDealState(
  deal: DealDetail,
  confirmedUserId?: string,
): Promise<void> {
  if (confirmedUserId) {
    await appendLeafBestEffort(
      { type: "participant_confirmed", subject: deal.id, tier: deal.tier },
      { dedupKey: `participant_confirmed:${deal.id}:${confirmedUserId}` },
    );
  }
  if (deal.tier !== "claimed") {
    await appendLeafBestEffort(
      { type: "deal_tiered", subject: deal.id, tier: deal.tier },
      { dedupKey: `deal_tiered:${deal.id}:${deal.tier}` },
    );
  }
}

/* ----------------------------------------------- witness cosignatures */

/**
 * The stored witness cosignatures over the head at a tree size, newest first.
 * These are the cosignatures the log serves alongside its own signed head so a
 * client can check the witness quorum. Each is a full canonical
 * WitnessCosignature (lib/witness.ts).
 */
export async function witnessCosignaturesForSize(
  treeSize: number,
): Promise<WitnessCosignature[]> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT cosignature FROM translog_witness_cosignatures
           WHERE tree_size = ? ORDER BY received_at ASC`,
    args: [treeSize],
  });
  return rs.rows.map((r) => JSON.parse(String(r.cosignature)) as WitnessCosignature);
}

export type StoreCosignatureResult = {
  status:
    | "stored" // accepted and recorded
    | "deduped" // already had this exact cosignature
    | "unrecognized" // not a witness this log's registry recognizes
    | "unknown_head" // no head at that size, or a different root than this log signed
    | "bad_signature" // the cosignature does not verify against the registered key
    | "witness_fork"; // this witness already cosigned a DIFFERENT root at this size
  message: string;
};

/**
 * Store a witness cosignature posted to POST /api/translog/add-checkpoint. The
 * log accepts a cosignature only when it is (1) from a RECOGNIZED witness,
 * (2) over a head this log actually signed (same size AND same root), and
 * (3) a valid Ed25519 signature by that witness's registered key. The
 * cryptographic acceptance IS the authentication: no session, no shared secret,
 * because only the witness holding the key can produce a passing cosignature,
 * and it must match a head we ourselves issued.
 *
 * A witness that already cosigned this size with a DIFFERENT root is itself
 * forking; that is recorded as `witness_fork` and refused, never overwritten,
 * because a witness double-signing a size is portable evidence, not a row to
 * silently replace.
 */
export async function storeWitnessCosignature(
  cosig: WitnessCosignature,
): Promise<StoreCosignatureResult> {
  if (!cosig || typeof cosig !== "object" || !Number.isInteger(cosig.treeSize)) {
    return { status: "bad_signature", message: "malformed cosignature" };
  }
  // The witness must be one the registry recognizes; trust flows through the
  // registered key, never the key the cosignature carries.
  const recognized = recognizedWitnesses().find((w) => w.witnessId === cosig.witnessId);
  if (!recognized) {
    return { status: "unrecognized", message: "witness id is not in the recognized registry" };
  }
  // The head must be one this log signed, at that size, with that exact root.
  let head: Sth;
  try {
    head = await getSignedHead(cosig.treeSize);
  } catch {
    return { status: "unknown_head", message: `no signed head at size ${cosig.treeSize}` };
  }
  if (head.treeSize !== cosig.treeSize || head.rootHash.toLowerCase() !== cosig.rootHash.toLowerCase()) {
    return {
      status: "unknown_head",
      message: `cosignature root does not match the head this log signed at size ${cosig.treeSize}`,
    };
  }
  if (!verifyCosignature(cosig, recognized.publicKey, head)) {
    return { status: "bad_signature", message: "cosignature does not verify against the registered key" };
  }

  const db = await getDb();
  const existing = await db.execute({
    sql: `SELECT root_hash FROM translog_witness_cosignatures WHERE witness_id = ? AND tree_size = ?`,
    args: [cosig.witnessId, cosig.treeSize],
  });
  if (existing.rows[0]) {
    const priorRoot = String(existing.rows[0].root_hash).toLowerCase();
    if (priorRoot !== cosig.rootHash.toLowerCase()) {
      // The witness cosigned two different roots at one size: a fork by the
      // witness itself. Refuse and surface it; do not overwrite the record.
      return {
        status: "witness_fork",
        message: `witness ${cosig.witnessId.slice(0, 12)} already cosigned size ${cosig.treeSize} with a different root`,
      };
    }
    return { status: "deduped", message: "cosignature already stored" };
  }

  await db.execute({
    sql: `INSERT INTO translog_witness_cosignatures
            (witness_id, tree_size, root_hash, key_name, public_key, cosignature, cosigned_at, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(witness_id, tree_size) DO NOTHING`,
    args: [
      cosig.witnessId,
      cosig.treeSize,
      cosig.rootHash.toLowerCase(),
      recognized.keyName,
      recognized.publicKey,
      JSON.stringify(cosig),
      cosig.cosignedAt,
      now(),
    ],
  });
  return { status: "stored", message: "cosignature stored" };
}

/**
 * The signed head at a size (default current) EXTENDED with its witness
 * cosignatures and the quorum verdict. The core Sth fields are the same bytes
 * getSignedHead returns, so the log signature and every existing verifier are
 * untouched; the witness layer rides alongside. This is what /api/translog/sth
 * serves and /transparency/log renders.
 */
export async function getWitnessedHead(size?: number): Promise<WitnessedSth> {
  const sth = await getSignedHead(size);
  const cosignatures = await witnessCosignaturesForSize(sth.treeSize);
  const registry = recognizedWitnesses();
  const quorum = checkQuorum(sth, cosignatures, registry, witnessQuorumN());
  return {
    ...sth,
    cosignatures: quorum.valid,
    witnessing: {
      required: quorum.required,
      recognized: quorum.recognized,
      independent: quorum.independent,
      present: quorum.present,
      met: quorum.met,
    },
  };
}
