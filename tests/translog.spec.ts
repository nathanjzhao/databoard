/**
 * tests/translog.spec.ts
 *
 * The append-only Merkle transparency log (lib/translog.ts, lib/merkle.ts),
 * lib/receipts.ts and the recording incentives, verified end to end. Every
 * check carries a COUNTERFACTUAL the pre-change code (or a forged log) would
 * have failed, so a guard that always answered "valid" is caught here.
 *
 *   LOG-1  the live log serves a signed head; its Ed25519 signature verifies
 *          against the published key; the tree GROWS as real deals/receipts
 *          are recorded through the write paths.
 *   LOG-2  a co-attested deal mints a receipt bound to the log; the inclusion
 *          proof for its leaf is re-verified IN THIS PROCESS (root recomputed
 *          from the audit path, RFC 6962) against the signed head; one tampered
 *          node fails.
 *   LOG-3  capture the head at size A, record more, capture it at size B; the
 *          consistency proof A->B proves the size-A tree is a prefix of B; a
 *          FORGED rewrite (a leaf changed at an earlier seq) cannot validate.
 *   LOG-4  the public /transparency/log page verifies an inclusion proof in the
 *          browser (a real receipt -> valid; a tampered paste -> invalid), and
 *          scripts/verify-log.sh passes against the running server.
 *   LOG-5  PRIVACY: every leaf and every signed head is dumped and scanned; no
 *          raw amount (only $10k buckets), no buyer name, no contact/PII, no
 *          raw handle-to-identity appears anywhere.
 *   INC    the fee credit lowers an owed referral only for a timely evidenced
 *          deal; the leaderboard defaults to value-to-others; a higher-volume
 *          member gets a larger invite cap and higher matching priority; the
 *          engagement certificate is offered on a co-attested deal and refused
 *          on a solo claim.
 *
 * Shared-DB discipline, like every suite here: this creates its OWN accounts
 * (operator-minted invite codes that sort after the seed pool), asserts
 * RELATIVE facts, and only appends to the log, which nothing else asserts an
 * absolute size of.
 *
 * PRECONDITION: freshly reset + seeded DB and the built app on port 3947, the
 * way CI runs every suite:
 *   SERVER_PEPPER=... npm run reset-db && npm run seed
 *   CI=1 SERVER_PEPPER=... npx playwright test tests/translog.spec.ts
 */

import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  leafHashHex,
  merkleRootHex,
  inclusionProofHex,
  consistencyProofHex,
  verifyInclusionHex,
  verifyConsistencyHex,
  verifySth,
  EMPTY_TREE_ROOT_HEX,
  type Sth,
} from "../lib/merkle";
import {
  RECEIPT_PREFIX,
  mintReceiptForDeal,
  receiptPayloadForDeal,
  provenanceLine,
  certificateDate,
  CERTIFICATE_DISPUTE_WINDOW_DAYS,
  type ReceiptPayload,
} from "../lib/receipts";
import {
  recordingCreditBps,
  netAccrualCents,
  accrualCents,
  TIMELY_EVIDENCE_CREDIT_BPS,
  TIMELY_RECORDING_WINDOW_MS,
} from "../lib/referrals";
import {
  comparePriority,
  recorderStanding,
  recordedVolumeChip,
  RECORDED_VOLUME_BUCKETS,
  TRUSTED_RECORDER_MIN_TIER,
  type PriorityInput,
} from "../lib/matching";
import {
  maxUnusedInvites,
  MAX_UNUSED_INVITES,
  MAX_STANDING_INVITE_BONUS,
} from "../lib/invites";
import type { DealDetail } from "../lib/deals";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
const PORT = Number(process.env.PW_PORT ?? 3947);
const BASE = `http://localhost:${PORT}`;

/** One process-unique tag so a re-run against a non-reset DB never collides. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PW = "translog-verify-000";

/* -------------------------------------------------------------- test data */

// Reporter who mints receipts. Exact deal total is deliberately NOT a round
// $10k, so the bucket ($120k) is provably different from the figure (123457).
const REC = { realName: "Tay Ledger", org: "Translog Collective", contact: `tl-rec-${RUN}@example.org`, handle: "" };
// Confirms REC's main deal, making it co-attested.
const PART = { realName: "Rin Mercer", contact: `tl-part-${RUN}@example.org`, handle: "" };

const DEAL_M = { buyer: "Anthropic", total: "123457", myShare: "60000", partShare: "30000" };
const DEAL_S = { buyer: "OpenAI", total: "8000", myShare: "8000" };
// A second deal, recorded between the size-A and size-B checkpoints in LOG-3.
const DEAL_MORE = { buyer: "Google DeepMind", total: "77000", myShare: "40000", partShare: "20000" };

const OPERATOR = { username: "marble-pennant", password: "demo-demo-demo" };

/* ------------------------------------------------------- shared run state */

let context: BrowserContext;
let page: Page;
let pubKey = "";
let treeSizeBeforeFixture = 0;
let dealMId = "";
let dealSId = "";
let dealMoreId = "";
let receiptToken = "";
let receiptLeafHash = "";

/* ------------------------------------------------------------ DB helpers */

function db() {
  return createClient({ url: `file:${DB_PATH}` });
}

async function clearRateLimits() {
  const c = db();
  await c.execute("DELETE FROM rate_limits");
  c.close();
}

/* -------------------------------------------------------------- fetchers */

async function fetchSth(api: APIRequestContext, size?: number): Promise<Sth> {
  const res = await api.get(`/api/translog/sth${size != null ? `?size=${size}` : ""}`);
  expect(res.ok(), `GET /api/translog/sth${size != null ? `?size=${size}` : ""}`).toBe(true);
  return (await res.json()) as Sth;
}

async function fetchPubKey(api: APIRequestContext): Promise<string> {
  const res = await api.get("/api/translog/pubkey");
  expect(res.ok()).toBe(true);
  const { publicKey, algorithm } = (await res.json()) as { publicKey: string; algorithm: string };
  expect(algorithm).toBe("Ed25519");
  expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
  return publicKey;
}

function flip(hex: string): string {
  return hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");
}

/* ------------------------------------------------------------ UI helpers */

async function mintOperatorCodes(api: APIRequestContext, n: number): Promise<string[]> {
  const xff = { "x-forwarded-for": `203.0.113.${40 + Math.floor(Math.random() * 150)}` };
  const login = await api.post("/api/auth/login", {
    headers: xff,
    data: { username: OPERATOR.username, password: OPERATOR.password },
  });
  expect(login.status(), "operator login for minting").toBe(200);
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = await api.post("/api/invites", { headers: xff });
    expect(m.status(), "mint invite code").toBe(201);
    codes.push(String((await m.json()).code));
  }
  return codes;
}

async function signUp(
  p: Page,
  opts: { realName: string; org?: string; contact: string; inviteCode: string },
): Promise<string> {
  await p.goto("/signup");
  await expect(p.getByText("Say who you are, once")).toBeVisible();
  await p.getByLabel("Invite code").fill(opts.inviteCode);
  await p.getByLabel("Real name").fill(opts.realName);
  if (opts.org) {
    await p.getByRole("button", { name: "An organization" }).click();
    await p.getByPlaceholder("Org name").fill(opts.org);
  } else {
    await p.getByRole("button", { name: "Independent individual" }).click();
  }
  await p.getByLabel("Phone or email").fill(opts.contact);
  await p.getByRole("button", { name: "Send me a code" }).click();

  await expect(p.getByText("Type the code back")).toBeVisible();
  const demoCode = (await p.getByText(/^\d{6}$/).first().textContent())?.trim() ?? "";
  expect(demoCode).toMatch(/^\d{6}$/);
  await p.getByLabel("Six digit code").fill(demoCode);
  await p.getByRole("button", { name: "Continue" }).click();

  await expect(p.getByText("Pick what we actually keep")).toBeVisible();
  await p.getByLabel("Password").fill(PW);
  await p.getByRole("button", { name: "Create account" }).click();

  const handle =
    (await p.getByTestId("assigned-handle").textContent({ timeout: 15_000 }))
      ?.replace(/^@/, "")
      .trim() ?? "";
  expect(handle).toMatch(/^[a-z0-9][a-z0-9_-]{2,23}$/);
  await p.getByRole("button", { name: "Go to the board" }).click();
  await expect(p.getByText(`@${handle}`).first()).toBeVisible({ timeout: 15_000 });
  return handle;
}

async function signOut(p: Page) {
  await p.getByRole("button", { name: "Sign out" }).click();
  await p.waitForURL(/\/gate$/);
}

async function logIn(p: Page, username: string, password = PW) {
  await p.goto("/login");
  await p.getByLabel("Handle").fill(username);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname === "/");
  await p.reload();
  await expect(p.getByText(`@${username}`).first()).toBeVisible();
}

async function recordDeal(
  p: Page,
  opts: { buyer: string; total: string; myShare: string; participants: [string, string][] },
): Promise<string> {
  await p.goto("/deals/new");
  await expect(p.getByText("Say what closed, and who was in it.")).toBeVisible();
  await p.getByLabel("Buying lab").selectOption(opts.buyer);
  await p.getByLabel("Total value, USD").fill(opts.total);
  await p.getByLabel("Your share, USD").fill(opts.myShare);
  for (let i = 0; i < opts.participants.length; i++) {
    await p.getByRole("button", { name: "+ add participant" }).click();
    const [handle, share] = opts.participants[i];
    await p.getByLabel("Participant handle").nth(i).fill(handle);
    await p.getByLabel("Participant share in USD").nth(i).fill(share);
  }
  await p.getByRole("button", { name: "Record the deal" }).click();
  await p.waitForURL(/\/deals\/(?!new$)[^/]+$/);
  return p.url().split("/deals/")[1];
}

async function confirmMyShare(p: Page) {
  await p.goto("/deals");
  await expect(p.getByText("Needs your confirmation")).toBeVisible();
  const [res] = await Promise.all([
    p.waitForResponse((r) => r.request().method() === "POST" && /\/api\/deals\/[^/]+$/.test(r.url())),
    p.getByRole("button", { name: /Confirm my \$/ }).first().click(),
  ]);
  expect(res.status(), `POST ${res.url()}`).toBe(200);
}

/* ============================================================== pure math
 *
 * The RFC 6962 core, proven against an INDEPENDENT reference root, with a
 * tampered proof rejected at every size. This is the counterfactual spine: a
 * verifier that always returned true would fail here.
 */

function refRoot(hashes: string[]): string {
  if (hashes.length === 0) return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  if (hashes.length === 1) return hashes[0];
  let k = 1;
  while (k * 2 < hashes.length) k *= 2;
  const left = Buffer.from(refRoot(hashes.slice(0, k)), "hex");
  const right = Buffer.from(refRoot(hashes.slice(k)), "hex");
  return createHash("sha256").update(Buffer.concat([Buffer.from([1]), left, right])).digest("hex");
}

function leafN(i: number): string {
  return leafHashHex(new TextEncoder().encode(`translog-leaf-${i}`));
}

test("PURE RFC 6962 inclusion and consistency verify; every tampered proof is rejected", () => {
  expect(merkleRootHex([])).toBe(EMPTY_TREE_ROOT_HEX);
  expect(merkleRootHex([])).toBe(refRoot([]));

  const MAX = 24;
  let inclusionChecks = 0;
  let consistencyChecks = 0;
  for (let n = 1; n <= MAX; n++) {
    const hashes = Array.from({ length: n }, (_, i) => leafN(i));
    const root = merkleRootHex(hashes);
    expect(root, `root n=${n}`).toBe(refRoot(hashes));

    for (let m = 0; m < n; m++) {
      const pathProof = inclusionProofHex(m, hashes);
      expect(
        verifyInclusionHex({ leafHash: hashes[m], leafIndex: m, treeSize: n, auditPath: pathProof, root }),
        `inclusion n=${n} m=${m}`,
      ).toBe(true);
      // A different leaf at the same position must fail.
      expect(
        verifyInclusionHex({ leafHash: leafN(9999), leafIndex: m, treeSize: n, auditPath: pathProof, root }),
      ).toBe(false);
      // A flipped path element must fail.
      if (pathProof.length > 0) {
        const bad = [...pathProof];
        bad[0] = flip(bad[0]);
        expect(
          verifyInclusionHex({ leafHash: hashes[m], leafIndex: m, treeSize: n, auditPath: bad, root }),
        ).toBe(false);
      }
      inclusionChecks++;
    }

    for (let m = 1; m < n; m++) {
      const proof = consistencyProofHex(m, hashes);
      const firstHash = merkleRootHex(hashes.slice(0, m));
      expect(
        verifyConsistencyHex({ first: m, second: n, firstHash, secondHash: root, proof }),
        `consistency m=${m} n=${n}`,
      ).toBe(true);
      // A rewritten earlier tree (one leaf changed before position m) must fail.
      const rewritten = merkleRootHex([...hashes.slice(0, m - 1), leafN(5555)]);
      expect(
        verifyConsistencyHex({ first: m, second: n, firstHash: rewritten, secondHash: root, proof }),
      ).toBe(false);
      if (proof.length > 0) {
        const bad = [...proof];
        bad[0] = flip(bad[0]);
        expect(
          verifyConsistencyHex({ first: m, second: n, firstHash, secondHash: root, proof: bad }),
        ).toBe(false);
      }
      consistencyChecks++;
    }
  }
  expect(inclusionChecks).toBeGreaterThan(200);
  expect(consistencyChecks).toBeGreaterThan(150);
});

/* =========================================================== live fixture */

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "203.0.113.231" },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("00 fixture: two accounts, a co-attested deal (+receipt) and a solo deal", async ({ request }) => {
  pubKey = await fetchPubKey(request);
  // Capture the tree size BEFORE this suite writes anything, so LOG-1 can prove
  // the log grew through the real write paths (signup, deal, confirm, receipt).
  treeSizeBeforeFixture = (await fetchSth(request)).treeSize;
  expect(treeSizeBeforeFixture).toBeGreaterThan(0); // the seed populated it

  await clearRateLimits();
  const [cRec, cPart] = await mintOperatorCodes(request, 2);
  REC.handle = await signUp(page, { realName: REC.realName, org: REC.org, contact: REC.contact, inviteCode: cRec });
  await signOut(page);
  PART.handle = await signUp(page, { realName: PART.realName, contact: PART.contact, inviteCode: cPart });
  await signOut(page);

  await logIn(page, REC.handle);
  dealMId = await recordDeal(page, {
    buyer: DEAL_M.buyer,
    total: DEAL_M.total,
    myShare: DEAL_M.myShare,
    participants: [[PART.handle, DEAL_M.partShare]],
  });
  dealSId = await recordDeal(page, {
    buyer: DEAL_S.buyer,
    total: DEAL_S.total,
    myShare: DEAL_S.myShare,
    participants: [],
  });
  await signOut(page);

  // PART confirms -> DEAL_M is co-attested.
  await logIn(page, PART.handle);
  await confirmMyShare(page);
  await signOut(page);

  // REC opens the deal page: rendering mints the log-bound receipt (grows the
  // tree by the receipt_minted leaf) and surfaces the token.
  await logIn(page, REC.handle);
  await page.goto(`/deals/${dealMId}`);
  await expect(page.getByText("Portable receipt · engagement certificate")).toBeVisible();
  await page.getByRole("button", { name: "Show token" }).click();
  receiptToken = (await page.getByText(new RegExp(`^${RECEIPT_PREFIX}\\.`)).first().innerText()).trim();
  expect(receiptToken).toMatch(new RegExp(`^${RECEIPT_PREFIX}\\.[A-Za-z0-9_-]+\\.[0-9a-f]+$`));
  // REC stays logged in for the remaining live tests.

  expect(dealMId.length).toBeGreaterThan(0);
  expect(dealSId.length).toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ LOG-1 */

test("LOG-1 the signed head verifies against the published key and the tree grew", async ({ request }) => {
  const sth = await fetchSth(request);
  expect(sth.rootHash).toMatch(/^[0-9a-f]{64}$/);
  expect(sth.signature).toMatch(/^[0-9a-f]{64,}$/);
  // Genuinely signed by the published Ed25519 key.
  expect(verifySth(sth, pubKey), "live STH signature").toBe(true);
  // COUNTERFACTUAL: a tampered head must not verify.
  expect(verifySth({ ...sth, rootHash: flip(sth.rootHash) }, pubKey)).toBe(false);
  expect(verifySth({ ...sth, treeSize: sth.treeSize + 1 }, pubKey)).toBe(false);

  // The fixture's real deals, confirmation and receipt appended leaves: the
  // tree is strictly larger than before this suite ran.
  expect(
    sth.treeSize,
    `tree grew from ${treeSizeBeforeFixture} as deals/receipt were recorded`,
  ).toBeGreaterThan(treeSizeBeforeFixture);

  // The earlier checkpoint is still a genuinely signed head at its own size.
  const before = await fetchSth(request, treeSizeBeforeFixture);
  expect(before.treeSize).toBe(treeSizeBeforeFixture);
  expect(verifySth(before, pubKey)).toBe(true);
});

/* ------------------------------------------------------------------ LOG-2 */

test("LOG-2 the receipt is bound to the log; its inclusion proof re-verifies here; a tamper fails", async ({
  request,
}) => {
  // The receipt verifies and carries its log coordinates.
  const vr = await request.post("/api/receipts/verify", { data: { token: receiptToken } });
  expect(vr.status()).toBe(200);
  const body = (await vr.json()) as { valid: boolean; receipt: ReceiptPayload };
  expect(body.valid).toBe(true);
  expect(body.receipt.tier).toBe("co_attested");
  expect(body.receipt.dealId).toBe(dealMId);
  expect(body.receipt.log, "receipt is bound to the transparency log").toBeTruthy();
  receiptLeafHash = body.receipt.log!.leafHash;
  expect(receiptLeafHash).toMatch(/^[0-9a-f]{64}$/);

  // Fetch the inclusion proof for that leaf.
  const pr = await request.get(`/api/translog/proof/inclusion?leaf=${encodeURIComponent(receiptLeafHash)}`);
  expect(pr.ok(), "inclusion proof for the receipt leaf").toBe(true);
  const proof = (await pr.json()) as {
    leafHash: string;
    leafIndex: number;
    treeSize: number;
    auditPath: string[];
    rootHash: string;
    sth: Sth;
  };
  expect(proof.leafHash).toBe(receiptLeafHash);
  expect(proof.leafIndex).toBe(body.receipt.log!.seq - 1); // seq is 1-based, index 0-based

  // Recompute the root from the leaf and the audit path (RFC 6962), IN THIS
  // process, and check it against the signed head; check the head's signature.
  expect(
    verifyInclusionHex({
      leafHash: proof.leafHash,
      leafIndex: proof.leafIndex,
      treeSize: proof.treeSize,
      auditPath: proof.auditPath,
      root: proof.sth.rootHash,
    }),
    "recomputed root matches the signed head",
  ).toBe(true);
  expect(verifySth(proof.sth, pubKey), "the head over that size is signed").toBe(true);
  expect(proof.rootHash.toLowerCase()).toBe(proof.sth.rootHash.toLowerCase());

  // COUNTERFACTUAL 1: flip one node of the audit path -> the recomputed root no
  // longer matches, so verification MUST fail. (The tree is large, so the path
  // is non-empty; assert that too.)
  expect(proof.auditPath.length, "audit path is non-empty at this size").toBeGreaterThan(0);
  const badPath = [...proof.auditPath];
  badPath[0] = flip(badPath[0]);
  expect(
    verifyInclusionHex({
      leafHash: proof.leafHash,
      leafIndex: proof.leafIndex,
      treeSize: proof.treeSize,
      auditPath: badPath,
      root: proof.sth.rootHash,
    }),
    "a tampered audit-path node is rejected",
  ).toBe(false);

  // COUNTERFACTUAL 2: a different leaf at the same index cannot verify.
  expect(
    verifyInclusionHex({
      leafHash: leafN(4242),
      leafIndex: proof.leafIndex,
      treeSize: proof.treeSize,
      auditPath: proof.auditPath,
      root: proof.sth.rootHash,
    }),
  ).toBe(false);

  // A leaf hash absent from the log is a 404, not an error.
  const missing = await request.get(`/api/translog/proof/inclusion?leaf=${"0".repeat(64)}`);
  expect(missing.status()).toBe(404);
});

/* ------------------------------------------------------------------ LOG-3 */

test("LOG-3 consistency A->B proves append-only; a forged rewrite cannot validate", async ({ request }) => {
  // Capture the head at size A.
  const sthA = await fetchSth(request);
  const A = sthA.treeSize;
  expect(verifySth(sthA, pubKey)).toBe(true);

  // Record MORE: a second co-attested deal appends several leaves.
  dealMoreId = await recordDeal(page, {
    buyer: DEAL_MORE.buyer,
    total: DEAL_MORE.total,
    myShare: DEAL_MORE.myShare,
    participants: [[PART.handle, DEAL_MORE.partShare]],
  });
  await signOut(page);
  await logIn(page, PART.handle);
  await confirmMyShare(page);
  await signOut(page);
  await logIn(page, REC.handle);
  await page.goto(`/deals/${dealMoreId}`); // mint its receipt leaf too

  // Capture the head at size B.
  const sthB = await fetchSth(request);
  const B = sthB.treeSize;
  expect(B, "recording more grew the tree").toBeGreaterThan(A);
  expect(verifySth(sthB, pubKey)).toBe(true);

  // The consistency proof A->B: the size-A tree is an exact prefix of size-B.
  const cr = await request.get(`/api/translog/proof/consistency?from=${A}&to=${B}`);
  expect(cr.ok()).toBe(true);
  const cons = (await cr.json()) as {
    first: number;
    second: number;
    firstSth: Sth;
    secondSth: Sth;
    proof: string[];
  };
  expect(cons.firstSth.rootHash).toBe(sthA.rootHash);
  expect(cons.secondSth.rootHash).toBe(sthB.rootHash);
  expect(
    verifyConsistencyHex({
      first: A,
      second: B,
      firstHash: cons.firstSth.rootHash,
      secondHash: cons.secondSth.rootHash,
      proof: cons.proof,
    }),
    "the size-A tree is a prefix of the size-B tree",
  ).toBe(true);
  expect(verifySth(cons.firstSth, pubKey) && verifySth(cons.secondSth, pubKey)).toBe(true);

  // Reconstruct the size-A tree from the raw leaf rows and confirm our root
  // matches the signed one (cross-check the whole tree, not just the endpoint).
  const c = db();
  const rows = (
    await c.execute({
      sql: `SELECT leaf_hash FROM translog_leaves WHERE seq <= ? ORDER BY seq ASC`,
      args: [A],
    })
  ).rows;
  c.close();
  const leavesA = rows.map((r) => String(r.leaf_hash));
  expect(leavesA.length).toBe(A);
  expect(merkleRootHex(leavesA)).toBe(sthA.rootHash);

  // FORGE a rewrite: change one leaf at an earlier seq in a COPY and recompute.
  const forged = [...leavesA];
  forged[Math.floor(A / 2)] = leafN(31337);
  const forgedRoot = merkleRootHex(forged);
  expect(forgedRoot).not.toBe(sthA.rootHash); // the rewrite genuinely changed the root

  // The append-only witness catching the rewrite: the real proof cannot make a
  // forged earlier root consistent with the later tree.
  expect(
    verifyConsistencyHex({
      first: A,
      second: B,
      firstHash: forgedRoot,
      secondHash: cons.secondSth.rootHash,
      proof: cons.proof,
    }),
    "a forged earlier root is rejected by the consistency proof",
  ).toBe(false);

  // And a tampered proof node is rejected too.
  if (cons.proof.length > 0) {
    const badProof = [...cons.proof];
    badProof[0] = flip(badProof[0]);
    expect(
      verifyConsistencyHex({
        first: A,
        second: B,
        firstHash: cons.firstSth.rootHash,
        secondHash: cons.secondSth.rootHash,
        proof: badProof,
      }),
    ).toBe(false);
  }

  // Out-of-range sizes are refused by the endpoint.
  const bad = await request.get(`/api/translog/proof/consistency?from=${B}&to=${A}`);
  expect(bad.status()).toBe(400);
});

/* ------------------------------------------------------------------ LOG-4 */

test("LOG-4 the public page verifies inclusion in-browser; a tampered paste is invalid", async () => {
  // The verifier lives on a PUBLIC page. Drive it in the browser.
  await page.goto("/transparency/log");
  await expect(page.getByRole("heading", { name: "The ledger signs its own history." })).toBeVisible();

  const box = page.getByPlaceholder("rcpt_v1.… or a 64-hex leaf hash");
  await expect(box).toBeVisible();

  // A genuine receipt token -> the in-browser check reports it is in the log.
  await box.fill(receiptToken);
  await page.getByRole("button", { name: "Verify inclusion" }).click();
  await expect(page.getByText(/In the public log/)).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("root recomputed from the audit path matches the signed head"),
  ).toBeVisible();
  await expect(
    page.getByText("Ed25519 signature verifies against the published log key"),
  ).toBeVisible();

  // COUNTERFACTUAL A: a tampered receipt token fails the receipt check, so the
  // page never claims inclusion. Flip the last hex of the MAC.
  const tamperedToken = flip(receiptToken);
  expect(tamperedToken).not.toBe(receiptToken);
  await box.fill("");
  await box.fill(tamperedToken);
  await page.getByRole("button", { name: "Verify inclusion" }).click();
  await expect(page.getByText("Nothing to verify")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/In the public log/)).toHaveCount(0);

  // COUNTERFACTUAL B: a leaf hash that is not in the log is reported as absent.
  const notPresent = flip(receiptLeafHash);
  await box.fill("");
  await box.fill(notPresent);
  await page.getByRole("button", { name: "Verify inclusion" }).click();
  await expect(page.getByText("That leaf hash is not in the log.")).toBeVisible({ timeout: 15_000 });

  // The consistency box proves append-only between two anchored sizes.
  await page.getByLabel("From size").fill("1");
  const currentSize = String((await (await page.request.get("/api/translog/sth")).json()).treeSize);
  await page.getByLabel("To size").fill(currentSize);
  await page.getByRole("button", { name: "Verify consistency" }).click();
  await expect(page.getByText("Append-only holds")).toBeVisible({ timeout: 15_000 });

  // scripts/verify-log.sh passes against the running server (offline re-verify).
  const out = execFileSync("bash", [path.join(ROOT, "scripts", "verify-log.sh"), BASE], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(out).toContain("verify-log: OK");
  expect(out).toContain("tampered inclusion proof is rejected (guard)");
  expect(out).not.toContain("FAIL");
});

/* ------------------------------------------------------------------ LOG-5 */

test("LOG-5 PRIVACY: no raw amount, no buyer name, no contact, no handle in any leaf or head", async () => {
  const c = db();
  const [leafRows, headRows, userRows, dealRows] = await Promise.all([
    c.execute(`SELECT seq, payload_json FROM translog_leaves ORDER BY seq ASC`),
    c.execute(`SELECT tree_size, signed_head FROM translog_heads`),
    c.execute(`SELECT username FROM users`),
    c.execute(`SELECT total_usd FROM deals`),
  ]);
  c.close();

  expect(leafRows.rows.length, "the log is non-empty").toBeGreaterThan(0);

  const usernames = userRows.rows.map((r) => String(r.username));
  const rawTotals = dealRows.rows.map((r) => String(r.total_usd));
  // Buyer names never appear on the board except as blinded tokens; the seed
  // and this suite only use these labs.
  const buyerNames = ["Anthropic", "OpenAI", "Google DeepMind", "Meta", "xAI", "Mistral"];
  const bucketRe = /^(<\$10k|\$\d[\d.]*[kMB])$/;
  const allowedLeafKeys = new Set([
    "seq", "type", "ts", "subject", "amountBucket", "parties", "tier", "category", "reason",
  ]);
  const allowedHeadKeys = new Set(["v", "logId", "treeSize", "rootHash", "timestamp", "signature"]);

  const leafBlob = leafRows.rows.map((r) => String(r.payload_json)).join("\n");
  const headBlob = headRows.rows.map((r) => String(r.signed_head)).join("\n");
  const everything = leafBlob + "\n" + headBlob;

  // Only the human-readable STRING fields of a leaf; never the hex `subject`,
  // never the numeric seq/ts. A raw amount, handle or name could only ever
  // surface HERE, so scanning these is exact and free of hex/decimal-collision
  // false positives that a raw-blob scan of 64-hex digests would suffer.
  const textualFields: string[] = [];

  // Structural: each leaf is exactly the documented shape; ids are blinded and
  // amounts are bucketed. This is the core privacy guarantee, fully robust.
  for (const r of leafRows.rows) {
    const leaf = JSON.parse(String(r.payload_json)) as Record<string, unknown>;
    for (const k of Object.keys(leaf)) {
      expect(allowedLeafKeys.has(k), `leaf key "${k}" (seq ${r.seq}) is not an allowed field`).toBe(true);
    }
    expect(String(leaf.subject)).toMatch(/^[0-9a-f]{64}$/); // blinded HMAC, never a raw id
    expect(typeof leaf.seq).toBe("number");
    expect(typeof leaf.ts).toBe("number");
    if ("parties" in leaf) expect(Number.isInteger(leaf.parties as number)).toBe(true);
    if ("amountBucket" in leaf) {
      expect(String(leaf.amountBucket), `amountBucket "${String(leaf.amountBucket)}"`).toMatch(bucketRe);
    }
    for (const k of ["type", "tier", "category", "reason", "amountBucket"] as const) {
      if (typeof leaf[k] === "string") textualFields.push(leaf[k] as string);
    }
  }
  const textual = textualFields.join("\n");

  // STH payloads carry only a size, two digests, a timestamp and a signature.
  for (const r of headRows.rows) {
    const head = JSON.parse(String(r.signed_head)) as Record<string, unknown>;
    for (const k of Object.keys(head)) {
      expect(allowedHeadKeys.has(k), `head key "${k}" is not an allowed field`).toBe(true);
    }
  }

  // No raw exact dollar figure in any leaf field. Non-vacuous: the figure IS a
  // real deal total, yet only its $10k bucket appears.
  expect(rawTotals).toContain(DEAL_M.total); // 123457 is a genuine deal total
  for (const t of rawTotals) {
    expect(textual.includes(t), `raw amount ${t} leaked into a leaf field`).toBe(false);
  }
  expect(textual, "the $120k bucket for DEAL_M is present, bucketed").toContain("$120k");

  // No buyer name, no handle, no contact/PII marker in any leaf text field.
  const forbidden = [
    ...buyerNames,
    ...usernames,
    "@example", "+1 415", "buyerToken", "v2:", "@", "contact",
    REC.contact, PART.contact, REC.realName, PART.realName,
  ];
  for (const needle of forbidden) {
    expect(textual.includes(needle), `"${needle}" leaked into a leaf text field`).toBe(false);
  }

  // Extra strength: seed handles and buyer names contain characters OUTSIDE the
  // hex alphabet, so a raw-blob scan for them cannot collide with any digest.
  // Assert none appear anywhere in the full leaf+head blob (not even in a
  // subject), proving ids really are HMAC-blinded, not raw.
  const nonHex = /[g-z_\- ]/;
  for (const needle of [...usernames, ...buyerNames, REC.contact, PART.contact, REC.realName, PART.realName]) {
    if (nonHex.test(needle)) {
      expect(everything.includes(needle), `identity "${needle}" leaked into the log`).toBe(false);
    }
  }
});

/* ================================================================== INC */

test("INC-1 fee credit lowers an owed referral ONLY for a timely, evidenced deal (exact rule)", () => {
  const t = 1_700_000_000_000;
  // No stated close date -> no credit, evidence or not.
  expect(recordingCreditBps(t, null, true)).toBe(0);
  expect(recordingCreditBps(null, null, true)).toBe(0);
  // Timely but the earner committed no evidence -> no credit.
  expect(recordingCreditBps(t, t, false)).toBe(0);
  // Timely AND evidenced -> the full credit; window closed at the edge.
  expect(recordingCreditBps(t, t, true)).toBe(TIMELY_EVIDENCE_CREDIT_BPS);
  expect(recordingCreditBps(t, t + TIMELY_RECORDING_WINDOW_MS, true)).toBe(TIMELY_EVIDENCE_CREDIT_BPS);
  expect(recordingCreditBps(t, t + TIMELY_RECORDING_WINDOW_MS + 1, true)).toBe(0);
  // A far-future close date cannot buy the credit by recording now.
  expect(recordingCreditBps(t, t + 400 * 24 * 60 * 60 * 1000, true)).toBe(0);

  // The credit only ever LOWERS, never below zero, never above gross.
  const gross = accrualCents(60_000, 1);
  expect(netAccrualCents(60_000, 1, 0)).toBe(gross);
  expect(netAccrualCents(60_000, 1, TIMELY_EVIDENCE_CREDIT_BPS)).toBe(
    gross - Math.floor(gross * (TIMELY_EVIDENCE_CREDIT_BPS / 10000)),
  );
  expect(netAccrualCents(60_000, 1, TIMELY_EVIDENCE_CREDIT_BPS)).toBeLessThan(gross);
  expect(netAccrualCents(0, 1, TIMELY_EVIDENCE_CREDIT_BPS)).toBe(0);
  // COUNTERFACTUAL: the pre-feature charge (150000c) differs from the credited
  // charge (120000c). If the credit did nothing these would be equal.
  expect(netAccrualCents(60_000, 1, TIMELY_EVIDENCE_CREDIT_BPS)).not.toBe(gross);
});

test("INC-2 a higher-volume member gets a larger invite cap AND higher matching priority", () => {
  const BIG = RECORDED_VOLUME_BUCKETS[RECORDED_VOLUME_BUCKETS.length - 1] * 2;

  // Invite cap: standing tier from volume raises the cap over the base, capped.
  const emptyStanding = recorderStanding(0, 0);
  const bigStanding = recorderStanding(BIG, 2);
  expect(emptyStanding.tier).toBe(0);
  expect(bigStanding.tier).toBeGreaterThan(emptyStanding.tier);
  expect(bigStanding.tier).toBeGreaterThanOrEqual(TRUSTED_RECORDER_MIN_TIER);
  expect(maxUnusedInvites(emptyStanding.tier)).toBe(MAX_UNUSED_INVITES);
  expect(maxUnusedInvites(bigStanding.tier)).toBeGreaterThan(maxUnusedInvites(emptyStanding.tier));
  expect(maxUnusedInvites(99)).toBe(MAX_UNUSED_INVITES + MAX_STANDING_INVITE_BONUS); // capped
  // The high-volume member wears a bucketed chip; the record-empty one none.
  expect(recordedVolumeChip(BIG)).not.toBeNull();
  expect(recordedVolumeChip(0)).toBeNull();

  // Matching priority: within the SAME recency window, higher volume sorts first.
  const now = Date.now();
  const hi: PriorityInput = { createdAt: now, volumeUsd: BIG, evidenceBackedDeals: 2 };
  const lo: PriorityInput = { createdAt: now, volumeUsd: 0, evidenceBackedDeals: 0 };
  expect(comparePriority(hi, lo, now), "higher-volume ask sorts ahead").toBeLessThan(0);
  // COUNTERFACTUAL: strip the volume (equal tiers, equal createdAt) and the two
  // tie -- volume was exactly what put the member ahead.
  const hiFlat: PriorityInput = { ...hi, volumeUsd: 0, evidenceBackedDeals: 0 };
  expect(comparePriority(hiFlat, lo, now)).toBe(0);
});

test("INC-3 the engagement certificate is offered on a co-attested deal and refused on a solo claim", async () => {
  // Pure: a claimed/solo deal mints nothing; a co-attested one mints a token.
  const split = [
    { username: "aa", role: "reporter", status: "confirmed", confirmedAt: 1, shareUsd: 40_000 },
    { username: "bb", role: "participant", status: "confirmed", confirmedAt: 2, shareUsd: 10_000 },
  ];
  const base = { id: "unit-deal", buyerToken: "v2:deadbeef", buyerIsOther: false, totalUsd: 50_000, split };
  const claimed = { ...base, tier: "claimed" } as unknown as DealDetail;
  const coAttested = { ...base, tier: "co_attested" } as unknown as DealDetail;
  expect(mintReceiptForDeal(claimed), "solo/claimed mints nothing").toBeNull();
  expect(receiptPayloadForDeal(claimed)).toBeNull();
  expect(mintReceiptForDeal(coAttested)).toMatch(new RegExp(`^${RECEIPT_PREFIX}\\.`));

  // The provenance line reads as a dated track record with no exact figure.
  expect(CERTIFICATE_DISPUTE_WINDOW_DAYS).toBeGreaterThan(0);
  expect(certificateDate(Date.UTC(2026, 7, 20, 13, 45))).toBe("2026-08-20");
  const line = provenanceLine({
    tier: "co_attested",
    buyerShort: "2cee",
    buyerIsOther: false,
    amountBucket: "$120k",
    participants: ["aa", "bb"],
    attestedAt: Date.UTC(2026, 7, 20),
  });
  expect(line).toContain("co-attested");
  expect(line).toContain("$120k");
  expect(line).not.toContain("123457");

  // LIVE: REC (still logged in) sees the certificate on the co-attested DEAL_M,
  // and sees NO certificate affordance on the solo DEAL_S.
  await page.goto(`/deals/${dealMId}`);
  await expect(page.getByText("Portable receipt · engagement certificate")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show token" })).toBeVisible();

  await page.goto(`/deals/${dealSId}`);
  await expect(page.getByText("solo deal").first()).toBeVisible();
  await expect(page.getByText("Portable receipt · engagement certificate")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show token" })).toHaveCount(0);
});

test("INC-4 the leaderboard defaults to value-to-others, not value-to-self", async () => {
  await page.goto("/leaderboard");
  const toOthers = page.getByRole("columnheader", { name: /To others/ });
  const toSelf = page.getByRole("columnheader", { name: /To self/ });
  await expect(toOthers).toBeVisible();
  // Default active column is value-to-others.
  await expect(toOthers).toHaveAttribute("aria-sort", "descending");
  await expect(toSelf).toHaveAttribute("aria-sort", "none");

  // COUNTERFACTUAL: the default is specifically value-to-others. Click "To self"
  // and the active column moves -- proving the initial state was a real default,
  // not every column reading "descending".
  await page.getByRole("button", { name: /To self/ }).click();
  await expect(toSelf).toHaveAttribute("aria-sort", "descending");
  await expect(toOthers).toHaveAttribute("aria-sort", "none");

  await signOut(page);
});
