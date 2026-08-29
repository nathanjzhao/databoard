#!/usr/bin/env bash
#
# scripts/verify-log.sh [base-url]
#
# Terminal auditor for the append-only transparency log. Fetches the signed
# tree head, the public key, two proofs, and the witness registry, and verifies
# them OFFLINE with the repo's own lib/merkle.ts + lib/witness.ts, so the log
# never gets to grade its own answer.
#
#   scripts/verify-log.sh                                  # http://localhost:3947
#   scripts/verify-log.sh https://getdataboard.vercel.app
#
# What it checks, all against the published keys:
#   1. the signed tree head's signature is genuine;
#   2. INCLUSION: the first leaf (whose hash is the root of the size-1 tree)
#      is provably in the current tree, root recomputed from the audit path;
#   3. CONSISTENCY: the size-1 tree is an exact prefix of the current tree,
#      i.e. nothing recorded early was rewritten;
#   4. WITNESSES: every independent-witness cosignature the head carries is
#      re-verified against its registered key, and the N-of-M quorum is
#      reported. A head below quorum is shown as UNWITNESSED.
#
# By default an unwitnessed head is a WARNING, not a failure (a freshly
# deployed head may not be cosigned yet). Set REQUIRE_WITNESS_QUORUM=1 to make
# the quorum mandatory: then a head without >= N recognized cosignatures fails.
#
# Exits nonzero on any failure. Run from the repo (it imports ./lib/*).

set -euo pipefail

BASE="${1:-http://localhost:3947}"
BASE="${BASE%/}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "verify-log: target $BASE"

STH_JSON="$(curl -fsS "$BASE/api/translog/sth")"
KEY_JSON="$(curl -fsS "$BASE/api/translog/pubkey")"
WIT_JSON="$(curl -fsS "$BASE/api/translog/witnesses" || echo '{}')"

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
STH="$STH_JSON" KEY="$KEY_JSON" INCL="$INCL_JSON" CONS="$CONS_JSON" WIT="$WIT_JSON" \
REQUIRE_WITNESS_QUORUM="${REQUIRE_WITNESS_QUORUM:-0}" TREE_SIZE="$TREE_SIZE" \
node --input-type=module - <<'NODE'
import { verifyInclusionHex, verifyConsistencyHex, verifySth } from "./lib/merkle.ts";
import { verifyCosignature, checkQuorum } from "./lib/witness.ts";

const sth = JSON.parse(process.env.STH);
const { publicKey } = JSON.parse(process.env.KEY);
const incl = JSON.parse(process.env.INCL);
const cons = JSON.parse(process.env.CONS);
const wit = JSON.parse(process.env.WIT || "{}");
const requireQuorum = process.env.REQUIRE_WITNESS_QUORUM === "1";

let ok = true;
function check(label, pass) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
function warn(label) {
  console.log(`WARN  ${label}`);
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

// ---------------------------------------------------------------- witnesses
const recognized = (wit.witnesses ?? []).map((w) => ({
  keyName: w.keyName,
  publicKey: w.publicKey,
  witnessId: w.witnessId,
  operator: w.operator === true,
}));
const required = Number(wit.quorum?.required ?? 1);
const cosigs = sth.cosignatures ?? [];

if (recognized.length === 0) {
  warn("no witness registry served; skipping the witness quorum check");
} else {
  const q = checkQuorum(sth, cosigs, recognized, required);
  console.log(
    `      witnesses: ${q.present}/${q.required} required cosignatures present ` +
      `(recognized ${q.recognized}, independent ${q.independent})`,
  );
  for (const c of q.valid) {
    const w = recognized.find((r) => r.witnessId === c.witnessId);
    console.log(`      + ${w?.keyName ?? c.witnessId.slice(0, 12)}${w?.operator ? " (operator-run)" : ""}`);
  }
  // Every cosignature the head SHIPPED must re-verify against its registered
  // key: this is the guard that catches a tampered or mis-attributed cosig.
  for (const c of cosigs) {
    const w = recognized.find((r) => r.witnessId === c.witnessId);
    if (w) {
      check(`cosignature by ${w.keyName} re-verifies (size ${sth.treeSize})`, verifyCosignature(c, w.publicKey, sth));
    }
  }
  // A cosignature with a flipped byte MUST be rejected, or the check is theatre.
  if (q.valid.length > 0) {
    const w0 = recognized.find((r) => r.witnessId === q.valid[0].witnessId);
    const bad = { ...q.valid[0], signature: q.valid[0].signature.slice(0, -1) + (q.valid[0].signature.endsWith("0") ? "1" : "0") };
    check("tampered cosignature is rejected (guard)", !verifyCosignature(bad, w0.publicKey, sth));
  }

  if (q.met) {
    console.log(`      head is WITNESSED (quorum met)`);
  } else if (requireQuorum) {
    check(`witness quorum met (>= ${required})`, false);
  } else {
    warn(`head is UNWITNESSED: ${q.present}/${required} cosignatures. Set REQUIRE_WITNESS_QUORUM=1 to make this fatal.`);
  }
}

console.log(ok ? "\nverify-log: OK" : "\nverify-log: FAILED");
process.exit(ok ? 0 : 1);
NODE
