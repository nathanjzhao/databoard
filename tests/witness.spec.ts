/**
 * tests/witness.spec.ts
 *
 * The independent-witness layer (lib/witness.ts, lib/witnesses.ts, the
 * add-checkpoint / witnesses endpoints, scripts/witness.ts), the C2SP
 * tlog-witness / sigsum model, verified end to end. Every check carries a
 * COUNTERFACTUAL a broken or credulous witness would have failed.
 *
 *   WIT-1  PURE PROTOCOL. A witness cosigns head A from scratch; the tree is
 *          extended to B and the witness cosigns B ONLY after verifying the RFC
 *          6962 consistency proof A->B; then, THE FORK-DETECTION COUNTERFACTUAL:
 *          the operator forges a non-consistent head B' (an earlier leaf
 *          rewritten) and even signs it with the real log key, and the witness
 *          REFUSES to cosign it (not_consistent). A same-size fork, a stale
 *          base, a rollback and a bad log signature are each refused with their
 *          own code.
 *   WIT-2  COSIGNATURE VERIFICATION. A genuine cosignature verifies against the
 *          registered key and only the exact head; a tampered signature, a wrong
 *          key, and a different head are all rejected.
 *   WIT-3  QUORUM. checkQuorum counts one cosignature per recognized witness
 *          over the exact head; a duplicate does not inflate it, a cosig over a
 *          different head does not count, and N-of-M is enforced.
 *   WIT-4  LIVE add-checkpoint. A recognized witness cosigns the live head and
 *          POSTs it; the head then carries the cosignature and reports the
 *          quorum met. An unrecognized witness (403), a cosig over a head the
 *          log never signed (unknown_head), and a tampered cosig (bad_signature)
 *          are all refused by the endpoint.
 *   WIT-5  THE RUNNER. scripts/witness.ts cosigns the live head into an isolated
 *          state dir and is idempotent on a second run; when its stored state is
 *          corrupted to a root the log cannot prove consistency to, it writes a
 *          FORK alarm and exits nonzero instead of cosigning.
 *
 * PRECONDITION: the built app on port 3947 (CI runs `next start`), like every
 * suite. The pure checks need no server. This suite only APPENDS witness
 * cosignatures (nothing else asserts an absolute count of them) and never
 * appends log leaves, so it is safe against the shared DB.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

import {
  leafHashHex,
  merkleRootHex,
  consistencyProofHex,
  sthSigningBody,
  bytesToHex,
  utf8ToBytes,
  type Sth,
} from "../lib/merkle";
import {
  reviewCheckpoint,
  cosign,
  verifyCosignature,
  checkQuorum,
  witnessPublicKeyHex,
  witnessId,
  witnessSeedFromHex,
  WITNESS_COSIG_VERSION,
  type WitnessState,
  type RecognizedWitness,
  type WitnessCosignature,
} from "../lib/witness";

const ROOT = path.resolve(__dirname, "..");
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * The checked-in dev witness seed from lib/witnesses.ts. Not a secret (it is the
 * dev key, exactly like the dev SERVER_PEPPER); duplicated here so the live
 * tests can produce a cosignature the default registry recognizes without
 * depending on the runner's NODE_ENV.
 */
const DEV_WITNESS_SEED_HEX =
  "d17e57000000000000000077697402772696746e6573732d6465762d6b657921";
const DEV_WITNESS_KEY_NAME = "databoard-witness-operator";

/* ----------------------------------------------------- pure test helpers */

/** A throwaway "log" with an Ed25519 key, signing STHs exactly like the server. */
function makeLog(fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const publicKey = bytesToHex(ed25519.getPublicKey(seed));
  const logId = bytesToHex(sha256(utf8ToBytes(publicKey)));
  function sign(treeSize: number, rootHash: string, timestamp = 1): Sth {
    const head = { v: 1, logId, treeSize, rootHash, timestamp };
    const signature = bytesToHex(ed25519.sign(utf8ToBytes(sthSigningBody(head)), seed));
    return { ...head, signature };
  }
  return { seed, publicKey, logId, sign };
}

/** n distinct leaf hashes, deterministic. */
function leaves(n: number, salt = ""): string[] {
  return Array.from({ length: n }, (_, i) => leafHashHex(utf8ToBytes(`${salt}leaf-${i}`)));
}

const WITNESS_SEED = new Uint8Array(32).fill(9);
const WITNESS_PUB = witnessPublicKeyHex(WITNESS_SEED);
const WITNESS_ID = witnessId(WITNESS_PUB);

/* ============================================================= WIT-1 */

test("WIT-1 a witness cosigns append-only extensions and REFUSES a forged fork", () => {
  const log = makeLog(1);

  // Tree at size A = 4. A fresh witness (no prior state) cosigns it.
  const A = 4;
  const leavesA = leaves(7);
  const rootA = merkleRootHex(leavesA.slice(0, A));
  const sthA = log.sign(A, rootA);

  const r0 = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: null,
    request: { old: 0, consistencyProof: [], sth: sthA },
    witnessSeed: WITNESS_SEED,
    keyName: "w",
  });
  expect(r0.ok, "fresh witness cosigns head A from size 0").toBe(true);
  if (!r0.ok) return;
  expect(r0.advanced).toBe(true);
  expect(verifyCosignature(r0.cosignature, WITNESS_PUB, sthA)).toBe(true);
  const stateA: WitnessState = r0.newState;
  expect(stateA).toEqual({ logId: log.logId, treeSize: A, rootHash: rootA });

  // Extend to B = 7. The witness cosigns B only with a real consistency proof.
  const B = 7;
  const rootB = merkleRootHex(leavesA);
  const sthB = log.sign(B, rootB);
  const proofAB = consistencyProofHex(A, leavesA);

  const r1 = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: stateA,
    request: { old: A, consistencyProof: proofAB, sth: sthB },
    witnessSeed: WITNESS_SEED,
    keyName: "w",
  });
  expect(r1.ok, "witness cosigns B as a proven extension of A").toBe(true);
  if (!r1.ok) return;
  expect(verifyCosignature(r1.cosignature, WITNESS_PUB, sthB)).toBe(true);
  const stateB = r1.newState;

  // THE COUNTERFACTUAL. Forge a non-consistent head B': rewrite a leaf WITHIN
  // the witnessed prefix (index 1 of the first A), recompute a size-B tree, and
  // sign it with the REAL log key (the operator holds it and can sign a fork).
  const forgedLeaves = [...leavesA];
  forgedLeaves[1] = leafHashHex(utf8ToBytes("rewritten-history"));
  const forgedRootB = merkleRootHex(forgedLeaves);
  expect(forgedRootB).not.toBe(rootB);
  const sthBForged = log.sign(B, forgedRootB);
  expect(verifyCosignature(cosign(sthBForged, WITNESS_SEED), WITNESS_PUB, sthBForged)).toBe(true); // the sig itself would be valid...

  // ...but the witness, holding stateA, cannot be made to cosign it: no proof
  // extends the root it witnessed to the forged root. Try the honest A->B proof
  // (wrong root) AND a freshly built A->B' proof (which rebuilds a DIFFERENT A
  // prefix, so it fails against the witness's stored A root).
  const forgedProof = consistencyProofHex(A, forgedLeaves);
  for (const [label, proof] of [
    ["real A->B proof over the forged root", proofAB],
    ["forged A->B' proof (different prefix)", forgedProof],
  ] as const) {
    const rf = reviewCheckpoint({
      logPublicKey: log.publicKey,
      prior: stateA, // pretend the witness is still at A when the fork is pushed
      request: { old: A, consistencyProof: proof, sth: sthBForged },
      witnessSeed: WITNESS_SEED,
      keyName: "w",
    });
    expect(rf.ok, `witness REFUSES the forged head (${label})`).toBe(false);
    if (!rf.ok) expect(rf.code).toBe("not_consistent");
  }

  // A same-size fork: present size A with a DIFFERENT root -> code "fork".
  const forgedRootA = merkleRootHex(forgedLeaves.slice(0, A));
  const sthAForged = log.sign(A, forgedRootA);
  const rFork = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: stateA,
    request: { old: A, consistencyProof: [], sth: sthAForged },
    witnessSeed: WITNESS_SEED,
    keyName: "w",
  });
  expect(rFork.ok).toBe(false);
  if (!rFork.ok) expect(rFork.code).toBe("fork");

  // A stale base: witness is at B, request declares old=A -> code "stale_old".
  const rStale = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: stateB,
    request: { old: A, consistencyProof: proofAB, sth: sthB },
    witnessSeed: WITNESS_SEED,
    keyName: "w",
  });
  expect(rStale.ok).toBe(false);
  if (!rStale.ok) {
    expect(rStale.code).toBe("stale_old");
    expect(rStale.expectedSize).toBe(B);
  }

  // A rollback: witness at B, a smaller tree is presented -> code "rollback".
  const smaller = log.sign(5, merkleRootHex(leavesA.slice(0, 5)));
  const rRoll = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: stateB,
    request: { old: B, consistencyProof: [], sth: smaller },
    witnessSeed: WITNESS_SEED,
    keyName: "w",
  });
  expect(rRoll.ok).toBe(false);
  if (!rRoll.ok) expect(rRoll.code).toBe("rollback");

  // A bad log signature is refused before anything else.
  const rBadSig = reviewCheckpoint({
    logPublicKey: log.publicKey,
    prior: stateA,
    request: {
      old: A,
      consistencyProof: proofAB,
      sth: { ...sthB, signature: sthB.signature.slice(0, -1) + (sthB.signature.endsWith("0") ? "1" : "0") },
    },
    witnessSeed: WITNESS_SEED,
    keyName: "w",
  });
  expect(rBadSig.ok).toBe(false);
  if (!rBadSig.ok) expect(rBadSig.code).toBe("bad_log_signature");

  // A valid head, but for the WRONG log -> code "log_id_mismatch".
  const otherLog = makeLog(2);
  const sthOther = otherLog.sign(B, rootB);
  const rWrongLog = reviewCheckpoint({
    logPublicKey: otherLog.publicKey, // its own sig verifies...
    expectedLogId: log.logId, //       ...but this witness serves a different log
    prior: stateA,
    request: { old: A, consistencyProof: proofAB, sth: sthOther },
    witnessSeed: WITNESS_SEED,
    keyName: "w",
  });
  expect(rWrongLog.ok).toBe(false);
  if (!rWrongLog.ok) expect(rWrongLog.code).toBe("log_id_mismatch");
});

/* ============================================================= WIT-2 */

test("WIT-2 a cosignature verifies against the exact head and key, and nothing else", () => {
  const log = makeLog(3);
  const size = 5;
  const root = merkleRootHex(leaves(size));
  const sth = log.sign(size, root);
  const c = cosign(sth, WITNESS_SEED, { keyName: "w2" });

  expect(c.v).toBe(WITNESS_COSIG_VERSION);
  expect(c.witnessId).toBe(WITNESS_ID);
  expect(verifyCosignature(c, WITNESS_PUB, sth)).toBe(true);

  // Tampered signature.
  expect(
    verifyCosignature({ ...c, signature: c.signature.slice(0, -1) + (c.signature.endsWith("0") ? "1" : "0") }, WITNESS_PUB, sth),
  ).toBe(false);
  // Wrong verifying key.
  const otherPub = witnessPublicKeyHex(new Uint8Array(32).fill(11));
  expect(verifyCosignature(c, otherPub, sth)).toBe(false);
  // A different head at the same size (different root).
  const otherHead = log.sign(size, merkleRootHex(leaves(size, "x")));
  expect(verifyCosignature(c, WITNESS_PUB, otherHead)).toBe(false);
  // A different size.
  expect(verifyCosignature(c, WITNESS_PUB, log.sign(size + 1, root))).toBe(false);
  // A cosignature whose witnessId does not match its verifying key.
  expect(verifyCosignature({ ...c, witnessId: witnessId(otherPub) }, WITNESS_PUB, sth)).toBe(false);
});

/* ============================================================= WIT-3 */

test("WIT-3 the quorum counts one cosig per recognized witness over the exact head", () => {
  const log = makeLog(4);
  const size = 6;
  const root = merkleRootHex(leaves(size));
  const sth = log.sign(size, root);

  const seedX = new Uint8Array(32).fill(21);
  const seedY = new Uint8Array(32).fill(22);
  const pubX = witnessPublicKeyHex(seedX);
  const pubY = witnessPublicKeyHex(seedY);
  const registry: RecognizedWitness[] = [
    { keyName: "x", publicKey: pubX, witnessId: witnessId(pubX), operator: false },
    { keyName: "y", publicKey: pubY, witnessId: witnessId(pubY), operator: true },
  ];

  const cX = cosign(sth, seedX, { keyName: "x" });
  const cY = cosign(sth, seedY, { keyName: "y" });

  // One valid cosig, N=1 -> met; N=2 -> not met.
  expect(checkQuorum(sth, [cX], registry, 1).met).toBe(true);
  expect(checkQuorum(sth, [cX], registry, 2).met).toBe(false);

  // Both -> present 2, independent 1.
  const q2 = checkQuorum(sth, [cX, cY], registry, 2);
  expect(q2.met).toBe(true);
  expect(q2.present).toBe(2);
  expect(q2.independent).toBe(1);

  // A duplicate from X does not inflate the count.
  expect(checkQuorum(sth, [cX, { ...cX }], registry, 2).present).toBe(1);

  // A cosig over a DIFFERENT head does not count.
  const otherHead = log.sign(size, merkleRootHex(leaves(size, "z")));
  const cXother = cosign(otherHead, seedX, { keyName: "x" });
  expect(checkQuorum(sth, [cXother], registry, 1).met).toBe(false);

  // A cosig from an UNRECOGNIZED witness does not count.
  const cStranger = cosign(sth, new Uint8Array(32).fill(99), { keyName: "stranger" });
  expect(checkQuorum(sth, [cStranger], registry, 1).met).toBe(false);
});

/* ============================================================= WIT-4 (live) */

type WitnessedSthResp = Sth & {
  cosignatures: WitnessCosignature[];
  witnessing: { required: number; recognized: number; independent: number; present: number; met: boolean };
};

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url);
  expect(res.ok(), `GET ${url} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

test("WIT-4 a recognized witness cosigns the live head; the endpoint refuses forgeries", async ({ request }) => {
  // The registry the deployment serves must recognize the dev witness with N=1.
  const reg = await getJson<{
    quorum: { required: number; recognized: number; independent: number };
    witnesses: Array<{ keyName: string; witnessId: string; publicKey: string; operator: boolean }>;
  }>(request, "/api/translog/witnesses");
  expect(reg.quorum.required).toBeGreaterThanOrEqual(1);
  const devSeed = witnessSeedFromHex(DEV_WITNESS_SEED_HEX);
  const devPub = witnessPublicKeyHex(devSeed);
  const registered = reg.witnesses.find((w) => w.publicKey === devPub);
  expect(registered, "the default registry recognizes the dev witness key").toBeTruthy();

  const { publicKey: logPublicKey } = await getJson<{ publicKey: string }>(request, "/api/translog/pubkey");
  const head = await getJson<WitnessedSthResp>(request, "/api/translog/sth");
  const size = head.treeSize;
  test.skip(size === 0, "log is empty; nothing to cosign");

  // Review the live head from a fresh witness (old=0 needs no proof) and cosign.
  const review = reviewCheckpoint({
    logPublicKey,
    prior: null,
    request: { old: 0, consistencyProof: [], sth: head },
    witnessSeed: devSeed,
    keyName: registered!.keyName,
  });
  expect(review.ok, review.ok ? "" : (review as { message: string }).message).toBe(true);
  if (!review.ok) return;

  // POST it: a fresh store is 201.
  const post = await request.post("/api/translog/add-checkpoint", { data: review.cosignature });
  expect([200, 201]).toContain(post.status());
  const postBody = (await post.json()) as { status: string };
  expect(["stored", "deduped"]).toContain(postBody.status);

  // The head at that size now carries the cosignature and reports the quorum met.
  const after = await getJson<WitnessedSthResp>(request, `/api/translog/sth?size=${size}`);
  const mine = after.cosignatures.find((c) => c.witnessId === registered!.witnessId);
  expect(mine, "the served head carries our cosignature").toBeTruthy();
  expect(verifyCosignature(mine!, devPub, after)).toBe(true);
  expect(after.witnessing.present).toBeGreaterThanOrEqual(1);
  expect(after.witnessing.met).toBe(true);

  // Idempotent: posting the same cosignature again is a dedupe, never a fork.
  const again = await request.post("/api/translog/add-checkpoint", { data: review.cosignature });
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { status: string }).status).toBe("deduped");

  // COUNTERFACTUALS the endpoint must refuse:
  // (a) a cosignature from a key the registry does not recognize -> 403.
  const strangerReview = reviewCheckpoint({
    logPublicKey,
    prior: null,
    request: { old: 0, consistencyProof: [], sth: head },
    witnessSeed: new Uint8Array(32).fill(123),
    keyName: "stranger",
  });
  expect(strangerReview.ok).toBe(true);
  if (strangerReview.ok) {
    const res = await request.post("/api/translog/add-checkpoint", { data: strangerReview.cosignature });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { status: string }).status).toBe("unrecognized");
  }

  // (b) a recognized witness cosigning a root the log NEVER signed -> unknown_head.
  const fabricatedRoot = leafHashHex(utf8ToBytes(`fabricated-${RUN}`));
  const fabricated = cosign({ logId: head.logId, treeSize: size, rootHash: fabricatedRoot }, devSeed, {
    keyName: registered!.keyName,
  });
  const resFab = await request.post("/api/translog/add-checkpoint", { data: fabricated });
  expect(resFab.status()).toBe(400);
  expect(((await resFab.json()) as { status: string }).status).toBe("unknown_head");

  // (c) a tampered signature on an otherwise valid cosignature -> bad_signature.
  const tampered = {
    ...review.cosignature,
    signature: review.cosignature.signature.slice(0, -1) + (review.cosignature.signature.endsWith("0") ? "1" : "0"),
  };
  const resTamper = await request.post("/api/translog/add-checkpoint", { data: tampered });
  expect(resTamper.status()).toBe(400);
  expect(((await resTamper.json()) as { status: string }).status).toBe("bad_signature");
});

/* ============================================================= WIT-5 (runner) */

test("WIT-5 scripts/witness.ts cosigns the live head, is idempotent, and alarms on a fork", async ({ request }) => {
  const head = await getJson<WitnessedSthResp>(request, "/api/translog/sth");
  test.skip(head.treeSize === 0, "log is empty; nothing to cosign");
  const BASE = (test.info().project.use.baseURL as string) ?? "http://localhost:3947";

  const stateDir = mkdtempSync(path.join(tmpdir(), `witness-${RUN}-`));
  const keyName = `test-runner-${RUN}`;
  // A fresh, isolated witness key: --no-push so an unrecognized cosig never
  // hits the log, and its state lives entirely in the scratch dir.
  const seedHex = bytesToHex(new Uint8Array(32).fill(0x5a));
  const env = {
    ...process.env,
    WITNESS_STATE_DIR: stateDir,
    WITNESS_KEY_NAME: keyName,
    WITNESS_ED25519_SEED: seedHex,
  };
  const scriptArgs = [path.join(ROOT, "scripts", "witness.ts"), "--url", BASE, "--no-push"];

  // First run: cosigns the live head and writes durable state.
  const out1 = execFileSync(process.execPath, scriptArgs, { cwd: ROOT, env, encoding: "utf8" });
  expect(out1).toContain("cosigned size");
  const keyDir = path.join(stateDir, keyName);
  const statePath = path.join(keyDir, "state.json");
  const cosigPath = path.join(keyDir, `cosig-${head.treeSize}.json`);
  expect(existsSync(statePath)).toBe(true);
  expect(existsSync(cosigPath)).toBe(true);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as WitnessState;
  expect(state.treeSize).toBe(head.treeSize);

  // Verify the committed cosignature against the runner's own key.
  const seed = witnessSeedFromHex(seedHex);
  const cosig = JSON.parse(readFileSync(cosigPath, "utf8")) as WitnessCosignature;
  expect(verifyCosignature(cosig, witnessPublicKeyHex(seed), head)).toBe(true);

  // Second run: nothing new to cosign -> idempotent, no fork.
  const out2 = execFileSync(process.execPath, scriptArgs, { cwd: ROOT, env, encoding: "utf8" });
  expect(out2).toContain("already cosigned");

  // THE FORK COUNTERFACTUAL AT THE RUNNER LEVEL: corrupt the stored state so the
  // witness believes it cosigned a DIFFERENT root at this size. The log cannot
  // present a head consistent with that phantom root, so the runner must write a
  // FORK alarm and exit nonzero rather than cosign.
  const bogus = leafHashHex(utf8ToBytes(`bogus-root-${RUN}`));
  writeFileSync(statePath, JSON.stringify({ ...state, rootHash: bogus }, null, 2));
  let threw = false;
  try {
    execFileSync(process.execPath, scriptArgs, { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    threw = true;
    const e = err as { status?: number; stderr?: string; stdout?: string };
    expect(e.status).not.toBe(0);
    expect(`${e.stderr ?? ""}${e.stdout ?? ""}`).toMatch(/FORK|REFUSED|fork/i);
  }
  expect(threw, "the runner exits nonzero on a forked/inconsistent head").toBe(true);
  const forkFiles = readdirSync(keyDir).filter((f) => f.startsWith("FORK-"));
  expect(forkFiles.length, "a FORK alarm file was written").toBeGreaterThanOrEqual(1);
});
