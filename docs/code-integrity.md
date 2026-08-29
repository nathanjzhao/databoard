# Served-JS integrity (Code Verify, done honestly)

How to check that the JavaScript `getdataboard.vercel.app` runs matches the
code in this repo, and the exact point past which you are still trusting
someone. The public writeup is at `/transparency/code`; this is the repo-side
reference.

## The chain

1. **Manifest.** After `next build`, `scripts/gen-js-manifest.mjs` hashes every
   file under `.next/static/**` (all JS chunks, CSS, media, per-build
   manifests) into a canonical manifest with, per file, `{ path, sha256, bytes }`.
   It also records:
   - `entrypoints` (the mandatory app-shell bootstrap, from
     `.next/build-manifest.json`),
   - `inline` (the one stable inline Flight bootstrap and its hash; other inline
     scripts are per-request RSC data recognized by prefix),
   - `commit` / `buildId` (the build id is pinned to the commit by
     `generateBuildId` in `next.config.ts`, so static paths carry the commit),
   - `provenance` (repo, workflow, and the `gh attestation verify` command).

   Two copies, same bytes: `.next/build-manifest.sha256.json` (CI artifact,
   attested) and `lib/js-manifest.generated.json` (served at
   `/api/transparency/js-manifest`). Both gitignored; hashes are per-build.

2. **Attestation.** `.github/workflows/ci.yml` runs
   `actions/attest-build-provenance@v4` over the manifest after the build,
   signing its digest through Sigstore (SLSA build provenance) and binding it to
   the workflow identity at the commit. The manifest and the Sigstore bundle are
   uploaded as workflow artifacts. Only on pushes to this repo (PRs and forks
   have no id-token write).

3. **Log leaf.** `scripts/log-served-manifest.ts` writes the manifest digest as
   a `served_manifest` leaf in the append-only transparency log
   (`lib/translog.ts`), so which JS a deployment vouched for at a commit is
   tamper-evident like the deal ledger. Run at deploy against the deployment's
   own database:

   ```
   node scripts/log-served-manifest.ts                 # log the local file
   node scripts/log-served-manifest.ts --url https://getdataboard.vercel.app
   ```

4. **Outside verifier.** The trust anchor lives outside the origin (a page
   cannot honestly verify itself when the origin is the adversary):
   - `tools/code-verify-extension` (MV3, unpacked): inventories the loaded
     scripts/styles, hashes them locally, checks both directions against the
     manifest, pins repo + workflow, badges green/red.
   - `scripts/verify-served-js.sh <url> [samples|all] [--attest]`: `--attest`
     runs `gh attestation verify` over the live manifest against the pinned
     workflow, then hashes live assets against it. Without `--attest`, byte
     check only (no GitHub account needed).

## The honest residual

- **Detection, not prevention.** The verifier runs after scripts execute. A red
  result means distrust the session, not that you were protected.
- **Reproducibility gap.** Next.js is not byte-for-byte reproducible in 2026
  (nondeterministic Server Action ids + per-build secrets). Pinning the build id
  removes one source of drift, not this one. The claim is "served bytes match a
  manifest CI attested was built by workflow W from commit C", not "these bytes
  provably rebuild from public source".
- **Trust in CI / Sigstore / GitHub.** The attestation proves a named GitHub
  workflow signed the digest. It does not prove faithful compilation of the
  source, nor that prod serves those bytes. It moves trust from an anonymous
  server to a named, constrained builder.
- **Re-fetch vs executed bytes.** MV3 cannot read raw response bodies without
  debugger-level interception; the extension re-reads from cache to approximate
  executed bytes. Pair it with the terminal script.
- **Extension update channel.** Shipped unpacked, no auto-update; the pins
  change only when you reinstall the folder. That manual step is the boundary.

## Closing the loop on prod: prebuilt deploy (the one pending step)

The gap that matters most: CI builds and attests digest A, but Vercel rebuilds
independently and serves digest B, so `verify-served-js.sh --attest` against the
live site correctly returns 404 and fails loudly rather than lying. The chain is
sound for the CI artifact; it does not yet cover the bytes prod serves.

To make the served bytes the attested bytes, deploy the CI-built output instead
of letting Vercel rebuild. This needs one GitHub Actions secret, `VERCEL_TOKEN`
(a Vercel access token), and the project ids, which are not secret and already
live in `.vercel/project.json` (orgId + projectId).

A deploy job that closes the loop:

```yaml
# .github/workflows/deploy-prebuilt.yml  (enable after adding VERCEL_TOKEN)
name: deploy-prebuilt
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write        # Sigstore OIDC for the attestation
  attestations: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}       # or hardcode from .vercel/project.json
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
      - run: npx vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}
      # Attest the manifest over the ACTUAL deployed output, not .next/static:
      - run: node scripts/gen-js-manifest.mjs --root .vercel/output/static --commit ${{ github.sha }}
      - uses: actions/attest-build-provenance@v4
        with: { subject-path: build-manifest.sha256.json }
      # Deploy that exact prebuilt output; Vercel does not rebuild:
      - run: npx vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
```

This is now LIVE. `.github/workflows/deploy-prebuilt.yml` builds with
`vercel build`, attests the served manifest under its own workflow identity
(ATTEST_WORKFLOW), and deploys the prebuilt output, so Vercel does not rebuild
and the live digest equals the attested digest. Confirmed end to end:

    scripts/verify-served-js.sh https://getdataboard.vercel.app all --attest

passes both the Sigstore attestation (the live manifest's digest is signed by
nathanjzhao/databoard/.github/workflows/deploy-prebuilt.yml) and the per-asset
byte check (every served asset matches the attested manifest). So a skeptic can
confirm the bytes prod runs were built by a named GitHub workflow from the
pinned public commit, verified out of band, not self-served. The residuals above
(reproducibility, detection-not-prevention, trust in CI/Sigstore/GitHub) still
hold; this closes only the "does prod serve the attested build" gap.
