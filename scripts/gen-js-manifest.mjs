/**
 * scripts/gen-js-manifest.mjs
 *
 * Postbuild step (package.json wires it after `next build`): emit the canonical
 * integrity manifest of every EXECUTABLE and STYLE asset this deployment
 * serves, so an OUTSIDE verifier (tools/code-verify-extension, or
 * scripts/verify-served-js.sh) can hash the bytes the browser actually ran and
 * check them against a manifest CI attested. This is the WhatsApp Code Verify
 * model, stated honestly: it DETECTS a mismatch after the fact, it does not
 * prevent tampered code from running, and it lives outside the origin because
 * a page cannot trustworthily verify itself when the origin is the adversary.
 *
 * WHAT THE MANIFEST COVERS (manifest version 2):
 *   - files[]:   every file under .next/static/** (the /_next/static/ CDN
 *                surface): all chunks, css, media, and the per-build
 *                _buildManifest.js / _ssgManifest.js / _clientMiddlewareManifest.js.
 *                One entry each: { path, sha256, bytes }.
 *   - entrypoints: the MANDATORY app-shell bootstrap, read from
 *                .next/build-manifest.json (rootMainFiles, polyfillFiles,
 *                lowPriorityFiles), paths normalized to the files[] convention.
 *                These are the executables the extension REQUIRES to be present
 *                and loaded, so a stripped-down malicious shell is caught too.
 *   - inline:    the one STABLE inline bootstrap Next injects on every page,
 *                the React Flight data-channel preamble
 *                `(self.__next_f=self.__next_f||[]).push([0])`, with its
 *                sha256. The verifier checks it byte-for-byte. The other inline
 *                script on a page is the per-request RSC flight payload
 *                (`self.__next_f.push([1,...])`): that is DATA rendered by the
 *                already-hashed framework code, not a separately servable
 *                executable, so it is recognized by prefix, not pinned.
 *   - commit / buildId: the git commit this build was cut from. next.config.ts
 *                pins generateBuildId to that commit, so the .next/static/<id>/
 *                directory name is the commit, not a fresh random string.
 *   - provenance: repo, workflow, predicate type, and the exact
 *                `gh attestation verify` command. CI attests the sha256 of THIS
 *                file with actions/attest-build-provenance (Sigstore), binding
 *                the manifest digest to the workflow identity at this commit.
 *
 * HONEST RESIDUAL (spelled out on /transparency/code):
 *   - Next.js is not byte-for-byte reproducible in 2026 (nondeterministic
 *     Server Action ids + per-build secrets baked into chunks), so the claim is
 *     "the served bytes match a manifest CI attested was built by workflow W
 *     from commit C", NOT "these bytes provably rebuild from public source".
 *   - SLSA provenance proves W at repo/commit C signed digest D. It does not
 *     prove W faithfully compiled C, nor that prod serves D; the outside
 *     verifier hashing live bytes is what closes that last gap.
 *
 * TWO COPIES, SAME BYTES:
 *   .next/build-manifest.sha256.json   CI uploads this as a workflow artifact
 *                                      AND attests its digest. Committed
 *                                      nowhere (hashes are per-build).
 *   lib/js-manifest.generated.json     served by
 *                                      GET /api/transparency/js-manifest.
 *                                      Gitignored, like schema.generated.
 *
 * The served copy cannot be a build-time import: the hashes exist only after
 * `next build` finishes, and an import would freeze whatever bytes the file
 * held before the build. The route instead reads the file at request time, and
 * next.config.ts pins it into the route's serverless bundle with
 * outputFileTracingIncludes. Those include globs resolve DURING `next build`
 * (collect-build-traces globs the disk while writing .nft.json), so on a fresh
 * clone the file must already exist when the build runs: `--stub` writes a
 * placeholder before the build purely so the path exists at trace time; the
 * real post-build run then overwrites it. The route refuses to serve a stub
 * (503), so a build that skipped the post-build step says so instead of
 * claiming an empty manifest.
 *
 * Verify against a running deployment: scripts/verify-served-js.sh.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_VERSION = 2;
/** The React Flight data-channel global. Fixed by React/Next, not per build. */
const FLIGHT_GLOBAL = "__next_f";
/** The default repo identity, overridable by GITHUB_REPOSITORY in Actions. */
const DEFAULT_REPO = "nathanjzhao/databoard";
/**
 * The workflow whose identity attests this manifest's digest. The deployed
 * bytes are attested by deploy-prebuilt.yml (it builds AND deploys the same
 * output), so that workflow sets ATTEST_WORKFLOW; ci.yml keeps its default and
 * attests its own build. verify-served-js.sh reads this back out of the served
 * manifest, so pinning follows whichever workflow actually signed the digest.
 */
const ATTEST_WORKFLOW =
  process.env.ATTEST_WORKFLOW || ".github/workflows/ci.yml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servedPath = path.join(root, "lib", "js-manifest.generated.json");

// Pre-build stub pass: make sure the served path exists before `next build`
// so the file-trace glob can pick it up. Never clobbers an existing file.
if (process.argv.includes("--stub")) {
  if (!existsSync(servedPath)) {
    writeFileSync(
      servedPath,
      JSON.stringify(
        { version: MANIFEST_VERSION, stub: true, files: null },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "gen-js-manifest: wrote stub lib/js-manifest.generated.json (pre-build trace placeholder)",
    );
  } else {
    console.log(
      "gen-js-manifest: lib/js-manifest.generated.json present, stub pass is a no-op",
    );
  }
  process.exit(0);
}
// Honor the hardening suite's per-server distDir override, same as
// next.config.ts, so a stray NEXT_TEST_DIST_DIR build can still be walked.
const distDir = process.env.NEXT_TEST_DIST_DIR || ".next";
const distPath = path.join(root, distDir);
const staticDir = path.join(distPath, "static");

let staticStat;
try {
  staticStat = statSync(staticDir);
} catch {
  staticStat = null;
}
if (!staticStat || !staticStat.isDirectory()) {
  console.error(
    `gen-js-manifest: ${path.relative(root, staticDir)} not found. Run \`next build\` first; this script hashes its output.`,
  );
  process.exit(1);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Depth-first walk, returning paths relative to staticDir, posix separators. */
function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

const files = walk(staticDir).map((rel) => {
  const buf = readFileSync(path.join(staticDir, rel));
  return { path: rel, sha256: sha256(buf), bytes: buf.length };
});
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const filePaths = new Set(files.map((f) => f.path));

// The mandatory app-shell bootstrap, straight out of Next's build manifest.
// Paths there are prefixed "static/"; strip it to match the files[] convention
// (relative to .next/static, served under /_next/static/).
function normalizeEntry(p) {
  return p.replace(/^static\//, "");
}
let entrypoints = { rootMainFiles: [], polyfillFiles: [], lowPriorityFiles: [] };
try {
  const bm = JSON.parse(
    readFileSync(path.join(distPath, "build-manifest.json"), "utf8"),
  );
  entrypoints = {
    rootMainFiles: (bm.rootMainFiles || []).map(normalizeEntry),
    polyfillFiles: (bm.polyfillFiles || []).map(normalizeEntry),
    lowPriorityFiles: (bm.lowPriorityFiles || []).map(normalizeEntry),
  };
} catch (err) {
  console.error(
    "gen-js-manifest: could not read build-manifest.json for entrypoints:",
    err?.message ?? err,
  );
}
// Every named entrypoint must be a file we hashed, or the manifest is lying
// about what a verifier will find. Fail loudly rather than ship a gap.
const missingEntry = [
  ...entrypoints.rootMainFiles,
  ...entrypoints.polyfillFiles,
  ...entrypoints.lowPriorityFiles,
].filter((p) => !filePaths.has(p));
if (missingEntry.length > 0) {
  console.error(
    `gen-js-manifest: entrypoint(s) absent from .next/static, refusing to write: ${missingEntry.join(", ")}`,
  );
  process.exit(1);
}

// The stable inline bootstrap Next injects on every page: the Flight preamble.
const bootstrap = `(self.${FLIGHT_GLOBAL}=self.${FLIGHT_GLOBAL}||[]).push([0])`;
const inline = {
  flightGlobal: FLIGHT_GLOBAL,
  bootstrap,
  bootstrapSha256: sha256(Buffer.from(bootstrap, "utf8")),
  // Every other inline <script> on a page must be an RSC flight-data push,
  // recognized by this prefix. It is DATA the hashed framework code renders,
  // not a separately servable executable; anything inline that is neither the
  // bootstrap above nor this prefix is unexpected and flagged.
  dataPushPrefix: `self.${FLIGHT_GLOBAL}.push(`,
};

// The commit this build was cut from. next.config.ts pins the build id to the
// same value, so BUILD_ID and commit agree; read BUILD_ID as the record of the
// id actually baked into the static paths.
function resolveCommit() {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || null;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}
const commit = resolveCommit();
let buildId = null;
try {
  buildId = readFileSync(path.join(distPath, "BUILD_ID"), "utf8").trim();
} catch {
  buildId = commit;
}

const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
const provenance = {
  repo,
  workflow: ATTEST_WORKFLOW,
  predicateType: "https://slsa.dev/provenance/v1",
  // What CI does: attest the sha256 of THIS file with Sigstore, binding the
  // digest to the workflow identity at this commit. What an auditor runs to
  // check it (the manifest file downloaded from the live site is the subject):
  verify: `gh attestation verify <manifest.json> --repo ${repo} --signer-workflow ${repo}/${ATTEST_WORKFLOW}`,
  bundleArtifact: commit
    ? `js-manifest-attestation-${commit}`
    : "js-manifest-attestation",
  // Read honestly: this proves workflow W at this repo+commit signed this
  // manifest's digest. It does NOT prove W faithfully compiled the source, nor
  // that production serves these exact bytes. Hashing the live assets against
  // this manifest (the extension / verify-served-js.sh) is what closes the last
  // gap; the reproducibility gap is documented on /transparency/code.
  note: "SLSA provenance binds this manifest's digest to the CI workflow identity at this commit. It does not prove faithful compilation or that prod serves these bytes; an outside verifier hashing live assets closes that gap. Detection, not prevention.",
};

const manifest = {
  version: MANIFEST_VERSION,
  algo: "sha256",
  prefix: "/_next/static/",
  commit,
  buildId,
  generated_at: new Date().toISOString(),
  provenance,
  inline,
  entrypoints,
  file_count: files.length,
  files,
};

const json = JSON.stringify(manifest, null, 2) + "\n";
const artifactPath = path.join(distPath, "build-manifest.sha256.json");
writeFileSync(artifactPath, json);
writeFileSync(servedPath, json);

const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
const entryCount =
  entrypoints.rootMainFiles.length +
  entrypoints.polyfillFiles.length +
  entrypoints.lowPriorityFiles.length;
console.log(
  `gen-js-manifest: hashed ${files.length} files (${totalBytes} bytes) under ${path.relative(root, staticDir)}, ${entryCount} mandatory entrypoints, commit ${commit ?? "unknown"}`,
);
console.log(
  `gen-js-manifest: manifest sha256 ${sha256(Buffer.from(json, "utf8"))}`,
);
console.log(
  `gen-js-manifest: wrote ${path.relative(root, artifactPath)} and ${path.relative(root, servedPath)}`,
);
