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
