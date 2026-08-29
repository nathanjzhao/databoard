#!/usr/bin/env bash
#
# scripts/verify-served-js.sh <base-url> [samples|all] [--attest]
#
# Verify the JavaScript a deployment serves against the integrity manifest it
# publishes at /api/transparency/js-manifest. Two layers:
#
#   BYTE CHECK (always): fetch the manifest, then fetch a sample of the static
#   bundles it lists and check each one's SHA-256 and byte count against it.
#   Exits nonzero on any mismatch. This proves the static files the server
#   hands out match the manifest the SAME server published.
#
#   ATTESTATION (opt-in, --attest or VERIFY_ATTEST=1): before the byte check,
#   verify the Sigstore attestation CI made over the live manifest's digest,
#   with `gh attestation verify`, pinned to the repo + workflow named in the
#   manifest's own provenance block. This is what makes the manifest itself
#   third-party: it proves the digest was signed by that GitHub workflow
#   identity at that commit, so a lying server cannot just publish a manifest
#   of its lies. Read honestly: SLSA provenance proves workflow W at repo/commit
#   C signed digest D. It does NOT prove W faithfully compiled the source, nor
#   that prod serves D; the byte check below is what ties D to the live bytes,
#   and the reproducibility gap is documented on /transparency/code.
#
#   scripts/verify-served-js.sh https://getdataboard.vercel.app            # 8 samples, byte check
#   scripts/verify-served-js.sh https://getdataboard.vercel.app all        # every file
#   scripts/verify-served-js.sh https://getdataboard.vercel.app all --attest
#   scripts/verify-served-js.sh http://localhost:3977 20
#
# The attestation step is opt-in on purpose: a locally built deployment has no
# Sigstore attestation, so the default byte check stays usable in dev and in CI
# without a network round-trip to GitHub. The installed browser extension
# (tools/code-verify-extension) is the trust anchor that observes EXECUTED
# bytes; this script is its terminal counterpart.

set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: scripts/verify-served-js.sh <base-url> [samples|all] [--attest]" >&2
  exit 2
fi
shift

SAMPLES=8
ATTEST="${VERIFY_ATTEST:-0}"
for a in "$@"; do
  case "$a" in
    --attest) ATTEST=1 ;;
    all) SAMPLES="all" ;;
    *[!0-9]*) echo "verify-served-js: unrecognized argument '$a'" >&2; exit 2 ;;
    *) SAMPLES="$a" ;;
  esac
done
BASE="${BASE%/}"

if command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
else
  echo "verify-served-js: need shasum or sha256sum on PATH" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MANIFEST="$TMP/manifest.json"
if ! curl -fsS "$BASE/api/transparency/js-manifest" -o "$MANIFEST"; then
  echo "verify-served-js: FAIL: could not fetch $BASE/api/transparency/js-manifest" >&2
  exit 1
fi

# ---------------------------------------------------------- attestation phase
# Opt-in: verify the Sigstore attestation over the exact manifest bytes this
# server just served. The repo + workflow to pin come from the manifest's own
# provenance, so there is nothing to hardcode here.
if [ "$ATTEST" = "1" ]; then
  PROV="$(node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const p = m.provenance || {};
    process.stdout.write(`${p.repo || ""}\t${p.workflow || ""}`);
  ' "$MANIFEST")"
  REPO="${PROV%%$'\t'*}"
  WORKFLOW="${PROV#*$'\t'}"
  if [ -z "$REPO" ] || [ -z "$WORKFLOW" ]; then
    echo "verify-served-js: FAIL: --attest requested but the manifest carries no provenance (repo/workflow)" >&2
    exit 1
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "verify-served-js: SKIP attestation: gh (GitHub CLI) not on PATH." >&2
    echo "                  Install gh and re-run with --attest to verify the Sigstore bundle." >&2
    echo "                  The byte check below still runs; it checks bytes-vs-manifest, not the CI attestation." >&2
  else
    echo "verify-served-js: attestation: gh attestation verify (repo $REPO, workflow $WORKFLOW)"
    if gh attestation verify "$MANIFEST" \
        --repo "$REPO" \
        --signer-workflow "$REPO/$WORKFLOW" >/dev/null 2>"$TMP/gh.err"; then
      echo "verify-served-js: attestation OK: the live manifest's digest is signed by $REPO/$WORKFLOW"
    else
      echo "verify-served-js: FAIL attestation: gh attestation verify rejected the live manifest" >&2
      sed 's/^/                  /' "$TMP/gh.err" >&2 || true
      exit 1
    fi
  fi
fi

# ------------------------------------------------------------- byte check phase
# Pick the sample: evenly spaced across the sorted file list ("all" takes
# everything). Emits tab-separated "path sha256 bytes" lines.
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(m.files) || m.files.length === 0) {
    console.error("verify-served-js: manifest has no files array");
    process.exit(1);
  }
  const want = process.argv[2] === "all"
    ? m.files.length
    : Math.min(Math.max(parseInt(process.argv[2], 10) || 8, 1), m.files.length);
  const picked = [];
  for (let i = 0; i < want; i++) {
    picked.push(m.files[Math.floor((i * m.files.length) / want)]);
  }
  console.error(
    `manifest: v${m.version ?? "?"}, ${m.file_count} files, commit ${m.commit || "unknown"}, build ${m.buildId || "unknown"}, generated ${m.generated_at}`
  );
  for (const f of picked) console.log(`${f.path}\t${f.sha256}\t${f.bytes}`);
' "$MANIFEST" "$SAMPLES" > "$TMP/sample.tsv"

PASS=0
FAIL=0
while IFS="$(printf '\t')" read -r rel expected_sha expected_bytes; do
  out="$TMP/asset"
  url="$BASE/_next/static/$rel"
  if ! curl -fsS "$url" -o "$out"; then
    echo "FAIL  $rel  (fetch failed)" >&2
    FAIL=$((FAIL + 1))
    continue
  fi
  got_sha="$(sha "$out")"
  got_bytes="$(wc -c < "$out" | tr -d ' ')"
  if [ "$got_sha" = "$expected_sha" ] && [ "$got_bytes" = "$expected_bytes" ]; then
    echo "ok    $rel"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $rel" >&2
    echo "      expected sha256=$expected_sha bytes=$expected_bytes" >&2
    echo "      served   sha256=$got_sha bytes=$got_bytes" >&2
    FAIL=$((FAIL + 1))
  fi
done < "$TMP/sample.tsv"

echo "verify-served-js: $PASS ok, $FAIL failed against $BASE"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
