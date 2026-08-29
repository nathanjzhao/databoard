/**
 * scripts/anchor-sth.ts
 *
 * Externally anchor the transparency log's current Signed Tree Head by writing
 * it into the repo, so committing the change puts the head into public git
 * history. Once a head is in history others have pulled, the operator cannot
 * rewrite the log without the git record and a saved head disagreeing: this is
 * the external, tamper-evident witness that removes "trust us" from the
 * append-only claim.
 *
 * It writes two things under docs/transparency-log/:
 *   - sth-<treeSize>.json : the full signed head at that size (one per size),
 *   - anchors.ndjson       : one appended line per anchoring run.
 *
 * TWO MODES.
 *   Anchor the LIVE site (default, and what CI runs), no database needed:
 *       node scripts/anchor-sth.ts --url https://getdataboard.vercel.app
 *     It fetches /api/translog/sth and /api/translog/pubkey, VERIFIES the
 *     signature before trusting the head, and writes the files. This is the
 *     honest anchor: it witnesses the head the deployed log actually serves.
 *
 *   Anchor the LOCAL/CONFIGURED database directly:
 *       node scripts/anchor-sth.ts --local
 *     Computes and signs the head from the database this environment points
 *     at (lib/translog). Useful for dev and for an operator running against
 *     production credentials on their own machine.
 *
 * A stronger anchor is a public timestamping stamp of the head (e.g.
 * OpenTimestamps of sth-<treeSize>.json); see docs/transparency-log/README.md
 * for the hook. This script deliberately does not shell out to it, so it has
 * no new dependency, but the file it writes is exactly what you would stamp.
 */

import { writeFile, appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySth, coreSth, type Sth } from "../lib/merkle.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "docs", "transparency-log");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

async function fromUrl(base: string): Promise<{ sth: Sth; publicKey: string }> {
  const trimmed = base.replace(/\/+$/, "");
  const [sthRes, keyRes] = await Promise.all([
    fetch(`${trimmed}/api/translog/sth`),
    fetch(`${trimmed}/api/translog/pubkey`),
  ]);
  if (!sthRes.ok) throw new Error(`GET ${trimmed}/api/translog/sth -> ${sthRes.status}`);
  if (!keyRes.ok) throw new Error(`GET ${trimmed}/api/translog/pubkey -> ${keyRes.status}`);
  const sth = coreSth((await sthRes.json()) as Sth);
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  return { sth, publicKey };
}

async function fromDb(): Promise<{ sth: Sth; publicKey: string }> {
  // Imported lazily so the URL mode carries no database dependency at all.
  const { getSignedHead, logPublicKeyHex } = await import("../lib/translog.ts");
  const { closeDb } = await import("../lib/db.ts");
  try {
    const sth = await getSignedHead();
    return { sth, publicKey: logPublicKeyHex() };
  } finally {
    closeDb();
  }
}

async function main() {
  const base = arg("--url") ?? process.env.ANCHOR_STH_URL;
  const local = has("--local") || (!base && !process.env.ANCHOR_STH_URL);

  const { sth, publicKey } = local
    ? await fromDb()
    : await fromUrl(base ?? "https://getdataboard.vercel.app");

  // Never anchor a head we cannot verify: an anchor of a bad signature is
  // worse than no anchor.
  if (!verifySth(sth, publicKey)) {
    throw new Error("Refusing to anchor: the STH signature does not verify against the public key.");
  }

  await mkdir(OUT_DIR, { recursive: true });
  const sthPath = path.join(OUT_DIR, `sth-${sth.treeSize}.json`);

  // Idempotent: if we already anchored this exact size+root, do nothing, so a
  // scheduled run with no new leaves does not churn the git history.
  if (existsSync(sthPath)) {
    const prior = JSON.parse(await readFile(sthPath, "utf8")) as Sth;
    if (prior.rootHash === sth.rootHash) {
      console.log(`anchor: size ${sth.treeSize} already anchored (root unchanged); nothing to do.`);
      return;
    }
    // Same size, different root: that is a FORK. Record it loudly and refuse
    // to overwrite the earlier witness.
    const forkPath = path.join(OUT_DIR, `FORK-size-${sth.treeSize}-${Date.now()}.json`);
    await writeFile(forkPath, JSON.stringify({ prior, incoming: sth }, null, 2) + "\n");
    throw new Error(
      `FORK DETECTED at size ${sth.treeSize}: stored root ${prior.rootHash} != incoming ${sth.rootHash}. ` +
        `Wrote ${path.relative(ROOT, forkPath)}. Not overwriting the existing anchor.`,
    );
  }

  await writeFile(sthPath, JSON.stringify(sth, null, 2) + "\n");
  const line = JSON.stringify({
    treeSize: sth.treeSize,
    rootHash: sth.rootHash,
    logId: sth.logId,
    signedAt: sth.timestamp,
    anchoredAt: Date.now(),
    signature: sth.signature,
  });
  await appendFile(path.join(OUT_DIR, "anchors.ndjson"), line + "\n");

  console.log(`anchor: wrote ${path.relative(ROOT, sthPath)} (tree size ${sth.treeSize})`);
  console.log(`anchor: root ${sth.rootHash}`);
  console.log("anchor: commit docs/transparency-log/ to publish the witness.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
