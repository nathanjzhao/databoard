#!/usr/bin/env bash
#
# scripts/verify-served-js.sh <base-url> [samples]
#
# Step one of served-JS verification: fetch the manifest a deployment
# publishes at /api/transparency/js-manifest, then fetch a sample of the
# static bundles it lists and check each one's SHA-256 and byte count
# against it. Exits nonzero on any mismatch.
#
#   scripts/verify-served-js.sh https://getdataboard.vercel.app        # 8 samples
#   scripts/verify-served-js.sh http://localhost:3963 20
#   scripts/verify-served-js.sh https://getdataboard.vercel.app all    # every file
#
# What a pass proves: the static files this server hands out match the
# manifest the SAME server published. A lying server could publish a
# manifest of its lies, so step two is what makes it third-party: download
# the build-manifest.sha256.json artifact from the public CI run for the
# commit stamped in the site footer, and diff it against the manifest you
# just fetched. Both steps are spelled out on /transparency and in DEPLOY.md.

set -euo pipefail

BASE="${1:?usage: scripts/verify-served-js.sh <base-url> [samples|all]}"
SAMPLES="${2:-8}"
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
    `manifest: ${m.file_count} files, commit ${m.commit || "unknown"}, generated ${m.generated_at}`
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
