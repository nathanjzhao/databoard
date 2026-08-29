/**
 * scripts/log-served-manifest.ts
 *
 * Deploy-time hook that writes the served-JS integrity manifest into the
 * append-only transparency log as a `served_manifest` leaf: the sha256 of the
 * exact manifest bytes the deployment serves at /api/transparency/js-manifest
 * (the same digest CI attests with Sigstore), plus the build id and commit it
 * describes. Run it once against the deployment's database after a build ships,
 * so which JS the deployment vouched for at a commit is recorded in the same
 * witnessed log as the deal ledger.
 *
 * TWO INPUTS, one job.
 *   Local file (default): reads lib/js-manifest.generated.json (the exact bytes
 *   the route serves) and logs its digest.
 *       node scripts/log-served-manifest.ts
 *
 *   Live URL: fetches the manifest a running deployment serves and logs THAT
 *   digest, so the leaf records what the site actually hands out.
 *       node scripts/log-served-manifest.ts --url https://getdataboard.vercel.app
 *   (This still writes to the database THIS environment points at, so run it
 *   with the production database credentials to log into the production log.)
 *
 * Idempotent per (commit, digest): re-running for the same manifest reuses the
 * one leaf. Prints the leaf seq and hash so you can prove inclusion afterward
 * (scripts/verify-log.sh, or /api/translog/proof/inclusion?leaf=<hash>).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logServedManifest } from "../lib/translog.ts";
import { isDbConfigured } from "../lib/db.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!isDbConfigured()) {
    console.error(
      "log-served-manifest: no database configured; nothing to log into.",
    );
    process.exit(1);
  }

  const url = arg("--url");
  let manifestJson: string;
  let source: string;
  if (url) {
    const trimmed = url.replace(/\/+$/, "");
    const res = await fetch(`${trimmed}/api/transparency/js-manifest`);
    if (!res.ok) {
      console.error(
        `log-served-manifest: ${trimmed}/api/transparency/js-manifest returned ${res.status}`,
      );
      process.exit(1);
    }
    manifestJson = await res.text();
    source = `${trimmed}/api/transparency/js-manifest`;
  } else {
    const p = path.join(ROOT, "lib", "js-manifest.generated.json");
    manifestJson = await readFile(p, "utf8");
    source = path.relative(ROOT, p);
  }

  const leaf = await logServedManifest(manifestJson);
  if (!leaf) {
    console.error(
      `log-served-manifest: ${source} is a stub or not a manifest; run \`npm run build\` first.`,
    );
    process.exit(1);
  }

  console.log(`log-served-manifest: source ${source}`);
  console.log(`log-served-manifest: commit          ${leaf.commit ?? "unknown"}`);
  console.log(`log-served-manifest: build id        ${leaf.buildId}`);
  console.log(`log-served-manifest: manifest sha256 ${leaf.manifestSha256}`);
  console.log(
    `log-served-manifest: logged as leaf seq ${leaf.seq}, leaf hash ${leaf.leafHash}`,
  );
  console.log(
    `log-served-manifest: prove inclusion with /api/translog/proof/inclusion?leaf=${leaf.leafHash}`,
  );
}

main().catch((err) => {
  console.error("log-served-manifest: failed:", err);
  process.exit(1);
});
