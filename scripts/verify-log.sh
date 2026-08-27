#!/usr/bin/env bash
#
# scripts/verify-log.sh [base-url]
#
# Terminal auditor for the append-only transparency log. Fetches the signed
# tree head, the public key, and two proofs, and verifies them OFFLINE with
# the repo's own lib/merkle.ts, so the log never gets to grade its own answer.
#
#   scripts/verify-log.sh                                  # http://localhost:3947
#   scripts/verify-log.sh https://getdataboard.vercel.app
#
# What it checks, all against the published Ed25519 key:
#   1. the signed tree head's signature is genuine;
#   2. INCLUSION: the first leaf (whose hash is the root of the size-1 tree)
#      is provably in the current tree, root recomputed from the audit path;
#   3. CONSISTENCY: the size-1 tree is an exact prefix of the current tree,
#      i.e. nothing recorded early was rewritten.
#
# Exits nonzero on any failure. Run from the repo (it imports ./lib/merkle.ts).

set -euo pipefail

BASE="${1:-http://localhost:3947}"
BASE="${BASE%/}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "verify-log: target $BASE"

STH_JSON="$(curl -fsS "$BASE/api/translog/sth")"
KEY_JSON="$(curl -fsS "$BASE/api/translog/pubkey")"

TREE_SIZE="$(STH="$STH_JSON" node -e 'process.stdout.write(String(JSON.parse(process.env.STH).treeSize))' 2>/dev/null || true)"
if [ "${TREE_SIZE:-0}" = "0" ] || [ -z "${TREE_SIZE:-}" ]; then
  echo "verify-log: the log is empty (tree size 0); nothing to prove yet."
  exit 0
fi

# The root of the size-1 tree IS the first leaf's hash: use it as a real leaf
# to exercise the inclusion endpoint without needing to know a receipt.
STH1_JSON="$(curl -fsS "$BASE/api/translog/sth?size=1")"
LEAF0="$(S1="$STH1_JSON" node -e 'process.stdout.write(JSON.parse(process.env.S1).rootHash)')"

INCL_JSON="$(curl -fsS "$BASE/api/translog/proof/inclusion?leaf=$LEAF0")"
CONS_JSON="$(curl -fsS "$BASE/api/translog/proof/consistency?from=1&to=$TREE_SIZE")"

cd "$ROOT"
STH="$STH_JSON" KEY="$KEY_JSON" INCL="$INCL_JSON" CONS="$CONS_JSON" TREE_SIZE="$TREE_SIZE" \
node --input-type=module - <<'NODE'
import { verifyInclusionHex, verifyConsistencyHex, verifySth } from "./lib/merkle.ts";

const sth = JSON.parse(process.env.STH);
const { publicKey } = JSON.parse(process.env.KEY);
const incl = JSON.parse(process.env.INCL);
const cons = JSON.parse(process.env.CONS);

let ok = true;
function check(label, pass) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}

check(`signed tree head signature (size ${sth.treeSize})`, verifySth(sth, publicKey));
check(
  `inclusion of leaf 0 in tree of ${incl.treeSize}`,
  verifyInclusionHex({
    leafHash: incl.leafHash,
    leafIndex: incl.leafIndex,
    treeSize: incl.treeSize,
    auditPath: incl.auditPath,
    root: incl.sth.rootHash,
  }) && verifySth(incl.sth, publicKey),
);
check(
  `consistency: tree of ${cons.first} is a prefix of tree of ${cons.second}`,
  verifyConsistencyHex({
    first: cons.first,
    second: cons.second,
    firstHash: cons.firstSth.rootHash,
    secondHash: cons.secondSth.rootHash,
    proof: cons.proof,
  }) && verifySth(cons.firstSth, publicKey) && verifySth(cons.secondSth, publicKey),
);

// A tampered audit path MUST fail, or the check above proves nothing.
const tampered = [...incl.auditPath];
if (tampered.length > 0) {
  const h = tampered[0];
  tampered[0] = h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");
  check(
    "tampered inclusion proof is rejected (guard)",
    !verifyInclusionHex({
      leafHash: incl.leafHash,
      leafIndex: incl.leafIndex,
      treeSize: incl.treeSize,
      auditPath: tampered,
      root: incl.sth.rootHash,
    }),
  );
}

console.log(ok ? "\nverify-log: OK" : "\nverify-log: FAILED");
process.exit(ok ? 0 : 1);
NODE
