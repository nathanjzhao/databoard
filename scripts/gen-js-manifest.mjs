/**
 * scripts/gen-js-manifest.mjs
 *
 * Postbuild step (package.json wires it after `next build`): walk
 * .next/static/** and emit a manifest of every static asset the deployment
 * will serve under /_next/static, one entry per file: path, sha256, bytes.
 * Route-agnostic on purpose; which chunk a route loads changes with the
 * router, but the set of bytes the CDN may hand out does not.
 *
 * Two copies, same bytes:
 *   .next/build-manifest.sha256.json   CI uploads this as a workflow
 *                                      artifact, one per build, committed
 *                                      nowhere (hashes are per-build).
 *   lib/js-manifest.generated.json     served by
 *                                      GET /api/transparency/js-manifest.
 *                                      Gitignored, like schema.generated.
 *
 * The served copy cannot be a build-time import: the hashes exist only after
 * `next build` finishes, and an import would freeze whatever bytes the file
 * held before the build. The route instead reads the file at request time,
 * and next.config.ts pins it into the route's serverless bundle with
 * outputFileTracingIncludes. Those include globs resolve DURING `next build`
 * (collect-build-traces globs the disk while writing .nft.json), so on a
 * fresh clone the file must already exist when the build runs: `--stub`
 * writes a placeholder before the build purely so the path exists at trace
 * time; the real post-build run then overwrites it, and Vercel packages
 * functions after the whole build command, so the shipped bytes are the real
 * manifest. The route refuses to serve a stub (503), so a build that skipped
 * the post-build step says so instead of claiming an empty manifest.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servedPath = path.join(root, "lib", "js-manifest.generated.json");

// Pre-build stub pass: make sure the served path exists before `next build`
// so the file-trace glob can pick it up. Never clobbers an existing file.
if (process.argv.includes("--stub")) {
  if (!existsSync(servedPath)) {
    writeFileSync(
      servedPath,
      JSON.stringify({ version: 1, stub: true, files: null }, null, 2) + "\n",
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
const staticDir = path.join(root, distDir, "static");

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
  return {
    path: rel,
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
  };
});
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// The commit this build was cut from: Vercel stamps it in the env (the same
// value the footer renders); local builds fall back to git; neither is fatal.
let commit = process.env.VERCEL_GIT_COMMIT_SHA || null;
if (!commit) {
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    commit = null;
  }
}

const manifest = {
  version: 1,
  algo: "sha256",
  prefix: "/_next/static/",
  commit,
  generated_at: new Date().toISOString(),
  file_count: files.length,
  files,
};

const json = JSON.stringify(manifest, null, 2) + "\n";
const artifactPath = path.join(root, distDir, "build-manifest.sha256.json");
writeFileSync(artifactPath, json);
writeFileSync(servedPath, json);

const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
console.log(
  `gen-js-manifest: hashed ${files.length} files (${totalBytes} bytes) under ${path.relative(root, staticDir)}`,
);
console.log(
  `gen-js-manifest: wrote ${path.relative(root, artifactPath)} and ${path.relative(root, servedPath)}`,
);
