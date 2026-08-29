/**
 * lib/witness.ts
 *
 * The independent-witness protocol for the append-only Merkle transparency log
 * (lib/translog.ts, lib/merkle.ts). This is the C2SP tlog-witness / sigsum
 * "add-checkpoint" model, transcribed to one board.
 *
 * WHY A WITNESS EXISTS. The log's tree head is signed with a key HMAC-derived
 * from SERVER_PEPPER (lib/translog.ts), so the operator holds the private key
 * and CAN sign a fork: a second, divergent history shown to a different reader.
 * Consistency proofs plus the git/OTS anchors make a rewrite detectable after
 * the fact, but detection needs someone who kept the old head. A WITNESS is
 * that someone made into a protocol participant: it holds its OWN Ed25519 key
 * and its own durable memory of the last head it accepted, and it refuses to
 * cosign a new head unless the new head is a proven, append-only extension of
 * the exact head it last saw. Once N recognized witnesses have cosigned a head,
 * a client that requires that quorum will not trust ANY head those witnesses
 * did not cosign, so an operator fork has to make the witnesses double-sign,
 * i.e. collude, leak their keys, or roll back their state.
 *
 * WHAT THIS MODULE IS. Pure and ISOMORPHIC, like lib/merkle.ts: it imports
 * nothing server-only (no lib/db, no node:crypto), so the identical code runs
 *   - in the witness runner (scripts/witness.ts) that cosigns heads,
 *   - on the log side (lib/translog.ts) that stores and serves cosignatures,
 *   - in the browser (/transparency/log) and scripts/verify-log.sh that VERIFY
 *     cosignatures and check the quorum before trusting a head.
 * Private keys are always passed IN as a 32-byte seed; this module never reads
 * an environment or a database. Durable state (the witness's last head, the
 * stored cosignatures) is owned by the caller.
 *
 * THE PROTOCOL, exactly (reviewCheckpoint):
 *   A request presents (old, consistencyProof, newSth). The witness, holding
 *   its durable `prior` head, either cosigns or refuses:
 *     1. the log's Ed25519 signature over newSth must verify (bad_log_signature);
 *     2. newSth.logId must be the log this witness serves (log_id_mismatch);
 *     3. `old` must equal the witness's last cosigned size (stale_old) -- the
 *        request cannot pick a convenient base; it must extend what the witness
 *        actually last saw;
 *     4. newSth.treeSize must be >= old (rollback), and if it equals old the
 *        root must be byte-identical to the stored root (fork);
 *     5. the RFC 6962 CONSISTENCY proof old->new must verify against the
 *        witness's OWN stored old root, never a root the request supplied
 *        (not_consistent) -- this is the fork-detection step;
 *     6. only then does the witness advance its state to newSth and return its
 *        cosignature over (logId, treeSize, rootHash).
 *
 * A refusal is never a silent no: the caller (scripts/witness.ts) turns a
 * `fork` or `not_consistent` verdict into a loud, committed alarm file, because
 * that verdict is exactly the operator-fork counterfactual this whole design
 * exists to catch.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  verifySth,
  verifyConsistencyHex,
  canonicalJson,
  isHash,
  EMPTY_TREE_ROOT_HEX,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  type Sth,
} from "./merkle.ts";

/** Cosignature format version. Bump only on a breaking cosignature-shape change. */
export const WITNESS_COSIG_VERSION = 1 as const;

/* --------------------------------------------------------------- key + id */

/** A witness's Ed25519 public key, hex, from its 32-byte seed. */
export function witnessPublicKeyHex(seed: Uint8Array): string {
  return bytesToHex(ed25519.getPublicKey(seed));
}

/** A stable id for a witness: SHA-256 of its public key hex. Same idea as logId. */
export function witnessId(publicKeyHex: string): string {
  return bytesToHex(sha256(utf8ToBytes(publicKeyHex.trim().toLowerCase())));
}

/** Parse a 64-hex Ed25519 seed (what a witness key secret looks like). Throws on bad input. */
export function witnessSeedFromHex(hex: string): Uint8Array {
  const clean = (hex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error("witness seed must be 64 hex characters (32 bytes)");
  }
  return hexToBytes(clean);
}

/* --------------------------------------------------------- cosignature type */

/**
 * A witness's cosignature over a log head. It binds the witness's key to a
 * SPECIFIC (logId, treeSize, rootHash): the witness attests "I saw this exact
 * tree, and it was a consistent extension of the last tree I saw". It does NOT
 * cover the log's own timestamp, so it verifies against any STH with the same
 * logId/treeSize/rootHash.
 *
 * `publicKey` and `witnessId` ride along so a cosignature is self-describing,
 * but trust still flows through the RECOGNIZED-witness registry: a verifier
 * checks the signature against the registered key for that witnessId, never
 * against a key the cosignature itself carries.
 */
export type WitnessCosignature = {
  v: number;
  /** SHA-256 of the witness public key hex. Must equal witnessId(publicKey). */
  witnessId: string;
  /** Human label for the witness, e.g. "databoard-witness-ci". Non-authoritative. */
  keyName: string;
  /** The log this cosignature is about; must equal the STH's logId. */
  logId: string;
  /** Tree size cosigned. */
  treeSize: number;
  /** RFC 6962 Merkle root at treeSize, hex. */
  rootHash: string;
  /** Milliseconds since epoch when the witness cosigned. */
  cosignedAt: number;
  /** The witness Ed25519 public key hex (transport; verify via the registry). */
  publicKey: string;
  /** Ed25519 signature over witnessCosignatureBody, hex. */
  signature: string;
};

/**
 * The exact bytes a witness cosignature covers: everything but the signature
 * and the transport `publicKey`, canonicalized. Built explicitly (not by
 * deleting fields) so an unexpected extra field can never sneak into or out of
 * the signed message. Same discipline as sthSigningBody in lib/merkle.ts.
 */
export function witnessCosignatureBody(
  c: Pick<
    WitnessCosignature,
    "v" | "witnessId" | "keyName" | "logId" | "treeSize" | "rootHash" | "cosignedAt"
  >,
): string {
  return canonicalJson({
    domain: "databoard-witness-cosig-v1",
    v: c.v,
    witnessId: c.witnessId,
    keyName: c.keyName,
    logId: c.logId,
    treeSize: c.treeSize,
    rootHash: c.rootHash,
    cosignedAt: c.cosignedAt,
  });
}

/**
 * Sign an STH with a witness seed: the low-level primitive. It performs NO
 * consistency or freshness checks; reviewCheckpoint is the safe entry point
 * that only reaches this after every guard has passed. Exposed for callers
 * that have already established consistency by other means (and for tests).
 */
export function cosign(
  sth: Pick<Sth, "logId" | "treeSize" | "rootHash">,
  seed: Uint8Array,
  opts: { keyName?: string; cosignedAt?: number } = {},
): WitnessCosignature {
  const publicKey = witnessPublicKeyHex(seed);
  const base = {
    v: WITNESS_COSIG_VERSION,
    witnessId: witnessId(publicKey),
    keyName: opts.keyName ?? "",
    logId: sth.logId,
    treeSize: sth.treeSize,
    rootHash: sth.rootHash.toLowerCase(),
    cosignedAt: opts.cosignedAt ?? Date.now(),
  };
  const sig = ed25519.sign(utf8ToBytes(witnessCosignatureBody(base)), seed);
  return { ...base, publicKey, signature: bytesToHex(sig) };
}

/**
 * Verify a witness cosignature against a KNOWN public key (from the registry)
 * and the head it is claimed to cover. Returns false on any malformed input or
 * mismatch rather than throwing. A verifier passes the STH it is about to
 * trust; the cosignature must bind to that exact (logId, treeSize, rootHash).
 */
export function verifyCosignature(
  cosig: WitnessCosignature,
  witnessPublicKey: string,
  sth: Pick<Sth, "logId" | "treeSize" | "rootHash">,
): boolean {
  try {
    if (!cosig || typeof cosig !== "object") return false;
    if (typeof cosig.signature !== "string" || !isHash(cosig.rootHash)) return false;
    // The cosignature must be about the head we are trusting.
    if (
      cosig.logId !== sth.logId ||
      cosig.treeSize !== sth.treeSize ||
      cosig.rootHash.toLowerCase() !== sth.rootHash.toLowerCase()
    ) {
      return false;
    }
    // The claimed key must be the registered key, and its id must match.
    const pk = (witnessPublicKey ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pk)) return false;
    if (cosig.witnessId !== witnessId(pk)) return false;
    const msg = utf8ToBytes(
      witnessCosignatureBody({
        v: cosig.v,
        witnessId: cosig.witnessId,
        keyName: cosig.keyName,
        logId: cosig.logId,
        treeSize: cosig.treeSize,
        rootHash: cosig.rootHash.toLowerCase(),
        cosignedAt: cosig.cosignedAt,
      }),
    );
    return ed25519.verify(hexToBytes(cosig.signature), msg, hexToBytes(pk));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ witness state */

/** A witness's durable memory: the last head it cosigned. null = never cosigned. */
export type WitnessState = {
  logId: string;
  treeSize: number;
  rootHash: string;
};

/** Why a witness refused to cosign. Every value is a distinct, testable branch. */
export type WitnessRejectCode =
  | "malformed"
  | "bad_log_signature"
  | "log_id_mismatch"
  | "stale_old"
  | "rollback"
  | "fork"
  | "not_consistent";

export type CheckpointReview =
  | { ok: true; cosignature: WitnessCosignature; newState: WitnessState; advanced: boolean }
  | { ok: false; code: WitnessRejectCode; message: string; expectedSize?: number };

/**
 * The full add-checkpoint protocol (see the module header). Given the witness's
 * durable `prior` state, a request (old, consistencyProof, sth) and the log's
 * public key, either cosign the new head or refuse with a specific code.
 *
 * `witnessSeed` is the witness's private key; `expectedLogId`, when given, pins
 * the log identity so a witness bootstrapped for one log can never be tricked
 * into cosigning a different log's head. When `prior` is null the witness has
 * never cosigned: `old` must be 0 and the old root is the empty-tree root.
 */
export function reviewCheckpoint(args: {
  logPublicKey: string;
  expectedLogId?: string;
  prior: WitnessState | null;
  request: { old: number; consistencyProof: string[]; sth: Sth };
  witnessSeed: Uint8Array;
  keyName?: string;
  now?: number;
}): CheckpointReview {
  const { logPublicKey, prior, witnessSeed } = args;
  const { old, consistencyProof, sth } = args.request;

  // 1. Structural sanity on the presented head.
  if (
    !sth ||
    typeof sth !== "object" ||
    !Number.isInteger(sth.treeSize) ||
    sth.treeSize < 0 ||
    !isHash(sth.rootHash) ||
    typeof sth.logId !== "string" ||
    !Array.isArray(consistencyProof) ||
    !Number.isInteger(old) ||
    old < 0
  ) {
    return { ok: false, code: "malformed", message: "malformed checkpoint request" };
  }

  // 2. The log must actually have signed this head. A witness never cosigns a
  //    head whose log signature it cannot verify: that would launder a forgery.
  if (!verifySth(sth, logPublicKey)) {
    return {
      ok: false,
      code: "bad_log_signature",
      message: "the log signature over the presented head does not verify",
    };
  }

  // 3. Pin the log identity.
  const expectedLogId = args.expectedLogId ?? prior?.logId ?? sth.logId;
  if (sth.logId !== expectedLogId || (prior && prior.logId !== expectedLogId)) {
    return {
      ok: false,
      code: "log_id_mismatch",
      message: `head is for log ${sth.logId}, this witness serves ${expectedLogId}`,
    };
  }

  // 4. The request's declared `old` must equal what the witness actually last
  //    cosigned. A requester cannot pick a base the witness never saw.
  const witnessSize = prior?.treeSize ?? 0;
  if (old !== witnessSize) {
    return {
      ok: false,
      code: "stale_old",
      message: `request declares old=${old} but this witness last cosigned size ${witnessSize}`,
      expectedSize: witnessSize,
    };
  }

  // 5. No rollback: the new tree cannot be smaller than the one we cosigned.
  if (sth.treeSize < witnessSize) {
    return {
      ok: false,
      code: "rollback",
      message: `new size ${sth.treeSize} is smaller than cosigned size ${witnessSize}`,
      expectedSize: witnessSize,
    };
  }

  const oldRoot = prior ? prior.rootHash.toLowerCase() : EMPTY_TREE_ROOT_HEX;
  const newRoot = sth.rootHash.toLowerCase();

  // 6a. Re-presentation of the same size: idempotent iff the root is identical.
  //     A different root at the SAME size is a fork of the head we witnessed.
  if (sth.treeSize === witnessSize) {
    if (newRoot !== oldRoot) {
      return {
        ok: false,
        code: "fork",
        message: `size ${witnessSize} presented with root ${newRoot}, but this witness cosigned root ${oldRoot}`,
      };
    }
    const cosignature = cosign(sth, witnessSeed, {
      keyName: args.keyName,
      cosignedAt: args.now ?? Date.now(),
    });
    return {
      ok: true,
      cosignature,
      newState: { logId: sth.logId, treeSize: sth.treeSize, rootHash: newRoot },
      advanced: false,
    };
  }

  // 6b. A genuine extension: the RFC 6962 consistency proof old->new must
  //     verify against the witness's OWN stored old root. This is the step a
  //     forked or rewritten history cannot pass.
  const consistent = verifyConsistencyHex({
    first: witnessSize,
    second: sth.treeSize,
    firstHash: oldRoot,
    secondHash: newRoot,
    proof: consistencyProof,
  });
  if (!consistent) {
    return {
      ok: false,
      code: "not_consistent",
      message: `consistency proof ${witnessSize}->${sth.treeSize} does not verify against the witnessed root; refusing to cosign a non-append-only head`,
    };
  }

  const cosignature = cosign(sth, witnessSeed, {
    keyName: args.keyName,
    cosignedAt: args.now ?? Date.now(),
  });
  return {
    ok: true,
    cosignature,
    newState: { logId: sth.logId, treeSize: sth.treeSize, rootHash: newRoot },
    advanced: true,
  };
}

/* -------------------------------------------------------------- quorum policy */

/** A witness a client is willing to count: a stable id, a key, and a label. */
export type RecognizedWitness = {
  keyName: string;
  publicKey: string;
  witnessId: string;
  /**
   * True when this witness is run by the log operator. Counted toward the
   * quorum, but flagged everywhere so "witnessed" is never mistaken for
   * "independently witnessed": an operator-run witness raises the fork bar to
   * "the operator's witness must double-sign", not to true independence.
   */
  operator: boolean;
  /** Optional add-checkpoint URL a third party can point a runner at. */
  url?: string;
};

/**
 * A signed head served together with its witness cosignatures and the quorum
 * verdict. This is the extended STH shape /api/translog/sth returns: the core
 * Sth fields are byte-identical to before (so every existing verifier and the
 * log's own signature still check out), with the witness layer added alongside.
 */
export type WitnessedSth = Sth & {
  cosignatures: WitnessCosignature[];
  witnessing: {
    required: number;
    recognized: number;
    independent: number;
    present: number;
    met: boolean;
  };
};

export type QuorumResult = {
  /** Required cosignatures (N in N-of-M). */
  required: number;
  /** Recognized witnesses configured (M). */
  recognized: number;
  /** Recognized, independent (non-operator) witnesses configured. */
  independent: number;
  /** Valid distinct cosignatures present over this exact head. */
  present: number;
  /** Whether present >= required. */
  met: boolean;
  /** The cosignatures that verified, in registry order. */
  valid: WitnessCosignature[];
};

/**
 * Given a head, the cosignatures presented for it, the recognized-witness
 * registry and the required N, decide whether the witness quorum is met.
 *
 * Only counts cosignatures that (a) come from a recognized witness, (b) verify
 * against that witness's registered key, and (c) bind to this exact head. At
 * most one cosignature per witness is counted (the first that verifies), so a
 * single witness cannot inflate the count.
 *
 * FORK RESISTANCE (documented on /transparency/log and in verify-log.sh): with
 * M recognized witnesses, requiring N such that 2N > M means any two heads that
 * each reach a quorum share at least one witness, so an operator fork at the
 * same size would need a recognized witness to have cosigned two different
 * roots -- a double-sign that is itself portable proof of misbehaviour. With a
 * single operator-run witness (M=1, N=1) the property is weaker: a fork then
 * "only" needs that one witness to collude or leak its key. True independence
 * needs multiple EXTERNAL witnesses.
 */
export function checkQuorum(
  sth: Pick<Sth, "logId" | "treeSize" | "rootHash">,
  cosignatures: WitnessCosignature[],
  recognized: RecognizedWitness[],
  required: number,
): QuorumResult {
  const valid: WitnessCosignature[] = [];
  const counted = new Set<string>();
  for (const w of recognized) {
    if (counted.has(w.witnessId)) continue;
    const match = (cosignatures ?? []).find(
      (c) => c && c.witnessId === w.witnessId && verifyCosignature(c, w.publicKey, sth),
    );
    if (match) {
      valid.push(match);
      counted.add(w.witnessId);
    }
  }
  const independent = recognized.filter((w) => !w.operator).length;
  return {
    required,
    recognized: recognized.length,
    independent,
    present: valid.length,
    met: valid.length >= required,
    valid,
  };
}
