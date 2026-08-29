/**
 * lib/merkle.ts
 *
 * The RFC 6962 (Certificate Transparency) Merkle math, and the Signed Tree
 * Head canonicalization / verification, as ONE isomorphic module. It runs
 * unchanged in three places:
 *
 *   - the server (lib/translog.ts) building trees and generating proofs,
 *   - the browser (components/transparency/log-verifier.tsx) recomputing a
 *     root from an audit path and checking it against a signed head, so a
 *     visitor verifies inclusion and append-only-ness client-side,
 *   - the proof suite (tests/translog.spec.ts) exercising every algorithm.
 *
 * NOTHING here is secret. Signing lives in lib/translog.ts (it needs the
 * pepper-derived private key); this module only verifies a signature against
 * a published public key, which anyone may do. Hashing is @noble/hashes
 * SHA-256 and signature checks are @noble/curves Ed25519, both already
 * dependencies and both browser-safe.
 *
 * The tree, per RFC 6962:
 *   leaf hash   = SHA-256(0x00 || leaf_bytes)
 *   node hash   = SHA-256(0x01 || left || right)
 *   empty tree  = SHA-256("")
 *   MTH(D[n])   with k = largest power of two strictly < n:
 *                 n=0 -> empty, n=1 -> the one leaf hash,
 *                 else node(MTH(D[0:k]), MTH(D[k:n]))
 *
 * Proof generation follows PATH / SUBPROOF from the RFC; the two verifiers
 * are the RFC's own iterative algorithms (Sections 2.1.1 and 2.1.2),
 * transcribed carefully and proven against a brute-force reference in the
 * test. Working currency is lowercase hex at every boundary, because that is
 * what the JSON proof endpoints carry.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  concatBytes,
} from "@noble/hashes/utils.js";

/* --------------------------------------------------------------- hashing */

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

/** RFC 6962 leaf hash of raw leaf bytes: SHA-256(0x00 || bytes), hex. */
export function leafHashHex(leafBytes: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(LEAF_PREFIX, leafBytes)));
}

/** RFC 6962 interior node hash: SHA-256(0x01 || left || right), hex in, hex out. */
export function nodeHashHex(leftHex: string, rightHex: string): string {
  return bytesToHex(
    sha256(concatBytes(NODE_PREFIX, hexToBytes(leftHex), hexToBytes(rightHex))),
  );
}

/** MTH of the empty list is the hash of the empty string. */
export const EMPTY_TREE_ROOT_HEX = bytesToHex(sha256(new Uint8Array(0)));

const HEX64 = /^[0-9a-f]{64}$/;

/** True for a 64-char lowercase hex string (a SHA-256 digest). */
export function isHash(s: string): boolean {
  return typeof s === "string" && HEX64.test(s.trim().toLowerCase());
}

/** Largest power of two strictly less than n (n >= 2). Multiplication, so 53-bit safe. */
function largestPow2Below(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * MTH over an array of leaf HASHES (each already SHA-256(0x00 || leaf)).
 * Recomputed from the slice on every call; the log is small, so O(n log n)
 * hashing per root is fine and keeps the code a direct read of the RFC.
 */
export function merkleRootHex(leafHashes: string[]): string {
  const n = leafHashes.length;
  if (n === 0) return EMPTY_TREE_ROOT_HEX;
  if (n === 1) return leafHashes[0].toLowerCase();
  const k = largestPow2Below(n);
  return nodeHashHex(
    merkleRootHex(leafHashes.slice(0, k)),
    merkleRootHex(leafHashes.slice(k)),
  );
}

/* --------------------------------------------------------- proof generation */

/**
 * PATH(m, D[n]): the audit path proving the leaf at index m is in a tree of
 * n leaves. Bottom-up list of sibling subtree roots.
 */
export function inclusionProofHex(index: number, leafHashes: string[]): string[] {
  const n = leafHashes.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new Error("inclusionProof: index out of range");
  }
  if (n === 1) return [];
  const k = largestPow2Below(n);
  if (index < k) {
    return [
      ...inclusionProofHex(index, leafHashes.slice(0, k)),
      merkleRootHex(leafHashes.slice(k)),
    ];
  }
  return [
    ...inclusionProofHex(index - k, leafHashes.slice(k)),
    merkleRootHex(leafHashes.slice(0, k)),
  ];
}

/**
 * PROOF(m, D[n]): the consistency proof that the tree of the first m leaves
 * is a prefix of the tree of all n leaves. Empty when m is 0 or equal to n.
 */
export function consistencyProofHex(m: number, leafHashes: string[]): string[] {
  const n = leafHashes.length;
  if (!Number.isInteger(m) || m < 0 || m > n) {
    throw new Error("consistencyProof: m out of range");
  }
  if (m === 0 || m === n) return [];
  return subproof(m, leafHashes, true);
}

function subproof(m: number, leafHashes: string[], b: boolean): string[] {
  const n = leafHashes.length;
  if (m === n) return b ? [] : [merkleRootHex(leafHashes)];
  const k = largestPow2Below(n);
  if (m <= k) {
    return [
      ...subproof(m, leafHashes.slice(0, k), b),
      merkleRootHex(leafHashes.slice(k)),
    ];
  }
  return [
    ...subproof(m - k, leafHashes.slice(k), false),
    merkleRootHex(leafHashes.slice(0, k)),
  ];
}

/* ------------------------------------------------------- proof verification */

/**
 * RFC 6962 Section 2.1.1 inclusion verification. Recomputes the tree root
 * from the leaf hash and audit path and compares it to `root`. A single
 * altered path element, a wrong index, or a truncated path fails.
 */
export function verifyInclusionHex(args: {
  leafHash: string;
  leafIndex: number;
  treeSize: number;
  auditPath: string[];
  root: string;
}): boolean {
  const { leafIndex, treeSize } = args;
  const root = args.root.toLowerCase();
  if (
    !Number.isInteger(leafIndex) ||
    !Number.isInteger(treeSize) ||
    leafIndex < 0 ||
    leafIndex >= treeSize ||
    !isHash(args.leafHash) ||
    !args.auditPath.every(isHash)
  ) {
    return false;
  }
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = args.leafHash.toLowerCase();
  for (const pRaw of args.auditPath) {
    const p = pRaw.toLowerCase();
    if (sn === 0) return false; // path longer than the tree can justify
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHashHex(p, r);
      if ((fn & 1) === 0) {
        do {
          fn >>= 1;
          sn >>= 1;
        } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      r = nodeHashHex(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && r === root;
}

function isPowerOf2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * RFC 6962 Section 2.1.2 consistency verification. Proves the size-`first`
 * tree (root firstHash) is an exact prefix of the size-`second` tree (root
 * secondHash): nothing before position `first` was rewritten, only appended.
 */
export function verifyConsistencyHex(args: {
  first: number;
  second: number;
  firstHash: string;
  secondHash: string;
  proof: string[];
}): boolean {
  const { first, second } = args;
  const firstHash = args.firstHash.toLowerCase();
  const secondHash = args.secondHash.toLowerCase();
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(second) ||
    first < 0 ||
    first > second ||
    !isHash(firstHash) ||
    !isHash(secondHash) ||
    !args.proof.every(isHash)
  ) {
    return false;
  }
  // Same tree: no proof, and the roots must already match.
  if (first === second) return args.proof.length === 0 && firstHash === secondHash;
  // The empty tree is a prefix of every tree; nothing to walk.
  if (first === 0) return args.proof.length === 0;

  let path = args.proof.map((h) => h.toLowerCase());
  // When `first` is an exact power of two the old root is itself a subtree
  // root the generator omits; the verifier supplies it back.
  if (isPowerOf2(first)) path = [firstHash, ...path];
  if (path.length === 0) return false;

  let fn = first - 1;
  let sn = second - 1;
  while ((fn & 1) === 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = path[0];
  let sr = path[0];
  for (let i = 1; i < path.length; i++) {
    const c = path[i];
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = nodeHashHex(c, fr);
      sr = nodeHashHex(c, sr);
      if ((fn & 1) === 0) {
        do {
          fn >>= 1;
          sn >>= 1;
        } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      sr = nodeHashHex(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && fr === firstHash && sr === secondHash;
}

/* --------------------------------------------------------- canonical json */

/**
 * Deterministic JSON: object keys sorted, arrays kept in order. Two values
 * that are equal serialize to identical bytes, so a leaf hash and an STH
 * signature are stable no matter how the object was built. Same rule as
 * lib/receipts.ts; kept here too so this module stays free of server-only
 * imports and runs in the browser.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/* ----------------------------------------------------------------- STH */

/** A Signed Tree Head: the log's checkpoint at one tree size. */
export type Sth = {
  v: number;
  /** SHA-256 of the log public key, a stable id for this log. */
  logId: string;
  /** Number of leaves this head commits to. */
  treeSize: number;
  /** RFC 6962 Merkle root at treeSize, hex. */
  rootHash: string;
  /** Milliseconds since epoch when this head was signed. */
  timestamp: number;
  /** Ed25519 signature over the body below, hex. Absent while being built. */
  signature: string;
};

/**
 * Just the six signed fields of a head, dropping anything a transport wrapped
 * around it (the /api/translog/sth response now also carries witness
 * cosignatures). The anchor and OpenTimestamps scripts write/stamp this so the
 * immutable anchor files stay pure core heads and never freeze a volatile
 * witness snapshot; the signature still verifies, since these are exactly the
 * bytes it covers.
 */
export function coreSth(sth: Sth): Sth {
  return {
    v: sth.v,
    logId: sth.logId,
    treeSize: sth.treeSize,
    rootHash: sth.rootHash,
    timestamp: sth.timestamp,
    signature: sth.signature,
  };
}

/**
 * The exact bytes an STH signature covers: the head with the signature field
 * removed, canonicalized. Server signs these, everyone verifies these.
 */
export function sthSigningBody(sth: Omit<Sth, "signature">): string {
  return canonicalJson({
    v: sth.v,
    logId: sth.logId,
    treeSize: sth.treeSize,
    rootHash: sth.rootHash,
    timestamp: sth.timestamp,
  });
}

/**
 * Verify an STH's Ed25519 signature against a published public key (hex).
 * Public and pure: this is what the browser and scripts/verify-log.sh both
 * run. Returns false on any malformed input rather than throwing.
 */
export function verifySth(sth: Sth, publicKeyHex: string): boolean {
  try {
    if (!sth || typeof sth.signature !== "string" || !isHash(sth.rootHash)) {
      return false;
    }
    const msg = utf8ToBytes(sthSigningBody(sth));
    return ed25519.verify(hexToBytes(sth.signature), msg, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export { bytesToHex, hexToBytes, utf8ToBytes };
