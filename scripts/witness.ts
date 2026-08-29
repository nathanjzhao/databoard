/**
 * scripts/witness.ts
 *
 * A runnable independent WITNESS for the transparency log, the C2SP tlog-witness
 * / sigsum "add-checkpoint" client (protocol in lib/witness.ts). It holds its
 * OWN Ed25519 key and its own durable memory of the last head it cosigned, and
 * it advances that memory only across a head it can prove is an append-only
 * extension of the one it last saw. That is what turns "the operator could sign
 * a fork" into "a fork needs this witness to double-sign".
 *
 * A witness is only as independent as its key and its infra. Run by the log
 * operator (the scheduled .github/workflows/witness.yml, its own secret key),
 * it is PARTIAL independence: it raises the fork bar to the operator's own
 * witness colluding. Run by a THIRD PARTY on their own machine with their own
 * key, it is real independence. Same script, both roles.
 *
 *   node scripts/witness.ts                                  # cosign the live site
 *   node scripts/witness.ts --url https://getdataboard.vercel.app
 *   node scripts/witness.ts --url http://localhost:3947 --no-push
 *
 * KEY. WITNESS_ED25519_SEED (64 hex, 32 bytes) is the witness private key; set
 * it as a secret. Dev/CI falls back to the checked-in dev seed (lib/witnesses),
 * which is deterministic and proves nothing about an independent party.
 * WITNESS_KEY_NAME labels the key in cosignatures and file paths.
 *
 * STATE lives under docs/transparency-log/witnesses/<keyName>/:
 *   - state.json           the last head this key cosigned { logId, treeSize, rootHash }
 *   - cosig-<size>.json    one cosignature per size
 *   - cosignatures.ndjson  the append log of everything it cosigned
 *   - FORK-*.json          written ONLY when the log presents a non-consistent
 *                          or forked head: the alarm this whole design exists for
 *
 * The runner both COMMITS these files (the workflow does the git commit) and
 * POSTs the cosignature to /api/translog/add-checkpoint so the live head carries
 * it. --no-push skips the POST (commit-only, e.g. a fully offline witness).
 */

import { writeFile, appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySth, type Sth } from "../lib/merkle.ts";
import {
  reviewCheckpoint,
  witnessPublicKeyHex,
  witnessId,
  type WitnessState,
  type CheckpointReview,
} from "../lib/witness.ts";
import { activeWitnessSeed, isUsingDevWitnessKey } from "../lib/witnesses.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Where the witness keeps its durable state and cosignatures. Defaults to the
// committed folder; WITNESS_STATE_DIR redirects it, which a third party running
// their own witness (or a test) uses to keep state out of this repo's tree.
const WITNESS_DIR = process.env.WITNESS_STATE_DIR
  ? path.resolve(process.env.WITNESS_STATE_DIR)
  : path.join(ROOT, "docs", "transparency-log", "witnesses");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Slugify a key name for a filesystem path; keep it boring and collision-free. */
function keySlug(keyName: string): string {
  return keyName.replace(/[^A-Za-z0-9_.-]/g, "_") || "witness";
}

async function readState(stateFile: string): Promise<WitnessState | null> {
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as WitnessState;
  } catch {
    return null;
  }
}

async function main() {
  const base = (arg("--url") ?? process.env.WITNESS_LOG_URL ?? "https://getdataboard.vercel.app").replace(/\/+$/, "");
  const push = !has("--no-push");

  const { seed, keyName } = activeWitnessSeed();
  const pubKey = witnessPublicKeyHex(seed);
  const id = witnessId(pubKey);
  const dir = path.join(WITNESS_DIR, keySlug(keyName));
  const stateFile = path.join(dir, "state.json");

  console.log(`witness: key "${keyName}" id ${id.slice(0, 16)} (${isUsingDevWitnessKey() ? "DEV key" : "configured key"})`);
  console.log(`witness: public key ${pubKey}`);
  console.log(`witness: target ${base}`);

  // The new head the log currently serves, and the log's public key to check it.
  const head = await getJson<Sth>(`${base}/api/translog/sth`);
  const { publicKey: logPublicKey } = await getJson<{ publicKey: string }>(`${base}/api/translog/pubkey`);

  if (!verifySth(head, logPublicKey)) {
    throw new Error("witness: the live head's signature does not verify against the log public key; refusing to proceed.");
  }

  const prior = await readState(stateFile);
  const old = prior?.treeSize ?? 0;

  // The consistency proof from the head we last cosigned to the new head. None
  // is needed for the first cosignature (old=0) or a re-presentation (old=new);
  // a shrunk tree (new<old) is a rollback we still route through reviewCheckpoint.
  let consistencyProof: string[] = [];
  if (old > 0 && head.treeSize > old) {
    const cons = await getJson<{ proof: string[]; firstSth: Sth; secondSth: Sth }>(
      `${base}/api/translog/proof/consistency?from=${old}&to=${head.treeSize}`,
    );
    consistencyProof = cons.proof;
    // Cross-check: the proof's endpoints must be the head we stored and the head
    // we are about to cosign, or the log handed us a proof about other trees.
    if (prior && cons.firstSth.rootHash.toLowerCase() !== prior.rootHash.toLowerCase()) {
      await writeFork(dir, "old_root_mismatch", { prior, servedFirstSth: cons.firstSth });
      throw new Error(
        `witness: the log's consistency proof starts from root ${cons.firstSth.rootHash} but this witness cosigned ${prior.rootHash} at size ${old}. Wrote a FORK alarm.`,
      );
    }
  }

  const review: CheckpointReview = reviewCheckpoint({
    logPublicKey,
    prior,
    request: { old, consistencyProof, sth: head },
    witnessSeed: seed,
    keyName,
  });

  if (!review.ok) {
    // A fork / non-consistent head is the counterfactual we exist to catch:
    // record it loudly and fail. stale_old is benign (someone else advanced the
    // tree under a concurrent run); everything else is a real refusal.
    if (review.code === "fork" || review.code === "not_consistent" || review.code === "rollback") {
      await writeFork(dir, review.code, { prior, head, message: review.message });
    }
    throw new Error(`witness: REFUSED to cosign (${review.code}): ${review.message}`);
  }

  await mkdir(dir, { recursive: true });
  const cosig = review.cosignature;
  const cosigFile = path.join(dir, `cosig-${cosig.treeSize}.json`);

  // Idempotent: an existing cosig at this size with the same root means a
  // scheduled run with nothing new; do not churn git.
  if (existsSync(cosigFile)) {
    const prev = JSON.parse(await readFile(cosigFile, "utf8")) as { rootHash: string };
    if (prev.rootHash?.toLowerCase() === cosig.rootHash.toLowerCase()) {
      console.log(`witness: size ${cosig.treeSize} already cosigned (root unchanged); nothing to commit.`);
      if (push) await pushCosig(base, cosig);
      return;
    }
  }

  await writeFile(cosigFile, JSON.stringify(cosig, null, 2) + "\n");
  await writeFile(
    stateFile,
    JSON.stringify(review.newState, null, 2) + "\n",
  );
  await appendFile(
    path.join(dir, "cosignatures.ndjson"),
    JSON.stringify({
      witnessId: cosig.witnessId,
      keyName: cosig.keyName,
      logId: cosig.logId,
      treeSize: cosig.treeSize,
      rootHash: cosig.rootHash,
      cosignedAt: cosig.cosignedAt,
      old,
      advanced: review.advanced,
    }) + "\n",
  );

  console.log(
    `witness: cosigned size ${cosig.treeSize} (root ${cosig.rootHash.slice(0, 16)}…), advanced from ${old}. ` +
      `Wrote ${path.relative(ROOT, cosigFile)}.`,
  );

  if (push) await pushCosig(base, cosig);
  console.log("witness: commit docs/transparency-log/witnesses/ to publish the cosignature.");
}

async function pushCosig(base: string, cosig: unknown): Promise<void> {
  try {
    const res = await fetch(`${base}/api/translog/add-checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cosig),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    if (res.ok) {
      console.log(`witness: posted to the log (${body.status ?? res.status}).`);
    } else {
      console.warn(`witness: add-checkpoint returned ${res.status} (${body.status ?? "error"}): ${body.message ?? ""}`);
    }
  } catch (err) {
    console.warn(`witness: could not POST the cosignature (${err instanceof Error ? err.message : err}); the committed file still stands.`);
  }
}

async function writeFork(dir: string, code: string, detail: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `FORK-${code}-${Date.now()}.json`);
  await writeFile(file, JSON.stringify({ code, detail }, null, 2) + "\n");
  console.error(`witness: FORK ALARM (${code}) written to ${path.relative(ROOT, file)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
