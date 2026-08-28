/**
 * scripts/seed.ts
 *
 * Demo data, created through the REAL code paths: users via createUser() (so
 * password hashing and contact blind-indexing behave exactly as signup does)
 * and asks via serverMintBuyerTokenV2() (the same RFC 9497 OPRF the compose
 * form drives blind from the browser; a PRF is a function, so the tokens
 * seeded here are byte-identical to the ones the form would mint, and equal
 * names collide the way they should).
 *
 * Run with: npm run seed        (plain node, type stripping, no bundler)
 * Every demo account's password is "demo-demo-demo".
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { closeDb, getDb, now } from "../lib/db.ts";
import { createUser } from "../lib/auth.ts";
import { newId, normalizeContact } from "../lib/crypto.ts";
import { buyerChip } from "../lib/voprf.ts";
import { serverMintBuyerTokenV2 } from "../app/api/voprf/server.ts";
import { isKnownBuyer } from "../lib/buyers.ts";
import { commitMandate } from "../lib/mandates.ts";
import { packTags } from "../lib/taxonomy.ts";
import {
  commitEvidence,
  confirmDealShare,
  createDeal,
  declineDealShare,
} from "../lib/deals.ts";
import { consumeInvite, mintInvite } from "../lib/invites.ts";
import { confirmSettlement, recordSettlement } from "../lib/referrals.ts";
import { getSignedHead, loggedReceiptForDeal } from "../lib/translog.ts";
import { getDealForUser } from "../lib/deals.ts";
import { partyBaseFieldsFromPayload } from "../lib/receipts.ts";
import { partySigningBase, signReceiptBase } from "../lib/receipt-attest.ts";
import { storePartySig } from "../lib/party-sigs.ts";
import { appendMessage } from "../app/api/threads/store.ts";
import {
  createExchangeSession,
  appendExchangeEvent,
  appendWireClaim,
  setDemoBlob,
} from "../app/api/exchange/store.ts";
import {
  deriveIdentityKeys,
  signingKeysFromSeed,
  generateThreadKey,
  sealMessage,
  toB64url,
  wrapThreadKey,
  type IdentityKeys,
  type SigningKeys,
} from "../lib/e2ee.ts";
import {
  EXCHANGE_VERSION,
  GENESIS_PREV_HASH,
  WIRE_CLAIM_VERSION,
  WIRE_TERMINAL_STATUSES,
  accountNullifierHex,
  encryptDataset,
  eventHash,
  generateDek,
  dekCommitHex,
  n15Of,
  newSessionId,
  paymentCommitHex,
  signLeaf,
  uetrCommitHex,
  wireNonce,
  wireNonceCommitHex,
  wireRecordCommitHex,
  type ExchangeLeaf,
  type WireClaimLeaf,
} from "../lib/exchange.ts";
import type { SignedEventInput } from "../app/api/exchange/store.ts";

const DEMO_PASSWORD = "demo-demo-demo";

const USERS = [
  // The genealogy origin: the operator account every invite chain traces
  // back to. It posts nothing and deals nothing; it vouches.
  { username: "marble-pennant", accountType: "individual", contact: "seed-marble-pennant@example.com" },
  { username: "quiet-ledger", accountType: "org", contact: "seed-quiet-ledger@example.com" },
  { username: "granite-fox", accountType: "individual", contact: "seed-granite-fox@example.com" },
  { username: "midnight-audit", accountType: "org", contact: "+1 415 555 0101" },
  { username: "paper-trail", accountType: "individual", contact: "seed-paper-trail@example.com" },
  { username: "cold-copy", accountType: "org", contact: "+1 415 555 0102" },
  { username: "vellum", accountType: "individual", contact: "seed-vellum@example.com" },
] as const;

type AskSeed = {
  user: string;
  title: string;
  category: string;
  description: string;
  tags: string[];
  volume: string;
  priceBand: string;
  filledPct: number;
  buyer: string;
  status: "open" | "partial" | "closed";
  ageDays: number;
  /** null = legacy ask from before ask_terms; surfaces "terms unspecified". */
  exclusivity: "exclusive" | "nonexclusive" | null;
  /**
   * Affirmation age for the autoclose clock (ask_activity). Defaults to
   * ageDays (affirmed at posting). Asks older than 7 days that should stay
   * open carry a fresher affirmation; the one pre-aged ask below keeps its
   * stale one so the sweep has something real to close in tests.
   */
  affirmedDaysAgo?: number;
  /** Optional "Still ongoing" note, shown on the ask page as last update. */
  updateNote?: string;
};

const ASKS: AskSeed[] = [
  {
    user: "quiet-ledger",
    title: "Seed trajectories for a household-robotics RL environment",
    category: "rl-env-seed",
    description:
      "Teleop or scripted demonstrations in cluttered domestic scenes. Need object interaction diversity, not polish. Reset states and reward annotations a plus.",
    tags: ["video", "sensor", "3d"],
    volume: "5k episodes",
    priceBand: "$50k - $250k",
    filledPct: 20,
    buyer: "OpenAI",
    status: "partial",
    ageDays: 2,
    exclusivity: "nonexclusive",
  },
  {
    user: "granite-fox",
    title: "Contested-topic preference pairs, expert-rated",
    category: "human-pref",
    description:
      "Pairwise preferences on policy, health and finance answers from raters with verifiable domain credentials. Rater rationale text required.",
    tags: ["text"],
    volume: "120k pairs",
    priceBand: "$250k - $1M",
    filledPct: 0,
    buyer: "Anthropic",
    status: "open",
    ageDays: 3,
    exclusivity: "exclusive",
  },
  {
    user: "midnight-audit",
    title: "Long-horizon agent traces in real ERP systems",
    category: "agent-traj",
    description:
      "Multi-hour workflows in SAP or NetSuite sandboxes: procurement, invoicing, close. Screen capture plus action log, PII scrubbed at source.",
    tags: ["screen", "text", "tabular"],
    volume: "800 sessions",
    priceBand: "$50k - $250k",
    filledPct: 65,
    buyer: "Google DeepMind",
    status: "partial",
    ageDays: 5,
    exclusivity: "nonexclusive",
  },
  {
    user: "paper-trail",
    title: "Adversarial jailbreak conversations, human-authored",
    category: "red-team",
    description:
      "Novel multi-turn attacks written by people, not templates. Deduped against public jailbreak corpora. Attack taxonomy labels required.",
    tags: ["text"],
    volume: "30k conversations",
    priceBand: "$10k - $50k",
    filledPct: 100,
    buyer: "Anthropic",
    status: "closed",
    ageDays: 12,
    // Legacy ask from before terms existed: no ask_terms row on purpose,
    // so "terms unspecified" stays a rendered, testable state.
    exclusivity: null,
  },
  {
    user: "cold-copy",
    title: "Non-English clinical reasoning evals, physician-written",
    category: "eval",
    description:
      "Board-style clinical vignettes with gold answers and distractor rationales, in Hindi, Portuguese and Arabic. Original items only, no translations.",
    tags: ["text"],
    volume: "9k items",
    priceBand: "$50k - $250k",
    filledPct: 10,
    buyer: "OpenAI",
    status: "open",
    ageDays: 1,
    exclusivity: "exclusive",
  },
  {
    user: "vellum",
    title: "Expert speedrun demonstrations of legacy Windows games",
    category: "expert-demo",
    description:
      "Frame-tagged input streams from ranked players across 40 titles. Emulator setup docs included so environments can be reproduced.",
    tags: ["video", "screen"],
    volume: "2k hours",
    priceBand: "under $10k",
    filledPct: 0,
    buyer: "Riverbend Data Co-op",
    status: "open",
    ageDays: 4,
    exclusivity: "nonexclusive",
  },
  {
    user: "quiet-ledger",
    title: "Merged-PR triplets from private monorepos",
    category: "code-repo",
    description:
      "Issue, diff, review-thread triplets from production codebases with permissive contributor agreements. License chain must be documented.",
    tags: ["code", "text"],
    volume: "250k PRs",
    priceBand: "$1M+",
    filledPct: 35,
    buyer: "Meta AI",
    status: "partial",
    ageDays: 8,
    exclusivity: "exclusive",
    // Older than the 7-day clock but freshly affirmed, with the note the
    // ask page shows as "Last update".
    affirmedDaysAgo: 2,
    updateNote:
      "License review cleared two more archives this week. The remaining 65% is still wanted.",
  },
  {
    user: "midnight-audit",
    title: "Factory-floor multicam video with synchronized PLC logs",
    category: "multimodal",
    description:
      "Fixed-mount capture of assembly and fault events, timestamped against controller state. Consent chain and worker anonymization required.",
    tags: ["video", "sensor", "tabular"],
    volume: "600 hours",
    priceBand: "$250k - $1M",
    filledPct: 0,
    buyer: "Nvidia",
    status: "open",
    ageDays: 6,
    exclusivity: "nonexclusive",
  },
  {
    user: "granite-fox",
    title: "Regulatory filings corpus with obligation annotations",
    category: "domain-corpus",
    description:
      "EU and US financial filings with clause-level obligation and deadline tags, lawyer-reviewed. Annotation guidelines must ship with the data.",
    tags: ["text", "tabular"],
    volume: "1.2M documents",
    priceBand: "$10k - $50k",
    filledPct: 50,
    buyer: "Cohere",
    status: "partial",
    ageDays: 9,
    exclusivity: "exclusive",
    affirmedDaysAgo: 1,
  },
  {
    user: "cold-copy",
    title: "Call-center audio with consented emotion labels",
    category: "other",
    description:
      "Dual-channel support calls, released under explicit reuse consent, with per-utterance emotion and resolution labels. English and Spanish.",
    tags: ["audio", "text"],
    volume: "10k calls",
    priceBand: "undisclosed",
    filledPct: 0,
    buyer: "Scale AI",
    status: "open",
    ageDays: 0,
    exclusivity: "nonexclusive",
  },
  {
    // Pre-aged past the 7-day clock with no affirmation since posting:
    // the ask `npm run autoclose` (or GET /api/cron/autoclose) closes,
    // so the auto_stale path is exercisable against seed data.
    user: "paper-trail",
    title: "Weather-station sensor logs with calibration certificates",
    category: "domain-corpus",
    description:
      "Decade-long logs from private station networks, with per-instrument calibration records so drift can be modeled instead of guessed.",
    tags: ["sensor", "tabular"],
    volume: "400 station-years",
    priceBand: "under $10k",
    filledPct: 0,
    buyer: "Cohere",
    status: "open",
    ageDays: 10,
    exclusivity: "nonexclusive",
  },
];

type DealSeed = {
  reporter: string;
  buyer: string;
  /** Index into ASKS, or null for an unlinked deal. */
  askIndex: number | null;
  totalUsd: number;
  myShareUsd: number;
  note: string;
  participants: {
    username: string;
    shareUsd: number;
    action: "confirm" | "decline" | "pending";
  }[];
  /** Evidence commitments, applied after confirmations (confirmed rows only). */
  evidence: { username: string; doc: string; label: string }[];
  /** Messages dropped into the deal room, in order. */
  roomMessages: { from: string; body: string }[];
  ageDays: number;
  /**
   * When true the deal carries a reporter-stated close date (deal_close_dates),
   * stated at recording time so |recorded - stated| = 0 stays inside the timely
   * window (lib/referrals TIMELY_RECORDING_WINDOW_MS) even after the cosmetic
   * backdate slides both stamps back together. Every confirmed share whose
   * earner also committed evidence then earns the timely-recording fee credit,
   * so the credit renders live on the /invites pages of that deal's evidenced
   * parties. Only the fully evidence-committed deal sets this.
   */
  statedClose?: boolean;
};

/**
 * Five demo deals, exercising every state the ledger and leaderboard render:
 * one evidence-committed (tier 2, every counted dollar weighted 1.0 on the
 * board), two co-attested (weighted 0.5; one carries a declined share, which
 * counts nowhere), one solo claim (the unranked claimed-unattested figure),
 * one co-attested deal (index 4, reported by cold-copy) that carries a
 * counterparty sitting pending long enough to read as chronic AND is confirmed
 * by cold-copy's own inviter quiet-ledger. That last confirmation is
 * WITHIN-branch: reporter and confirmer share the non-root ancestor
 * quiet-ledger within two hops, so the sybil-independence rule (lib/independence
 * .ts) grants cold-copy zero collaborator and value-to-others credit for it
 * while the referral fee on the share is still owed in full. The cross-branch
 * confirmations on the other deals share only the root and count normally, so
 * the board shows real brought-in figures beside the one discounted case.
 * Created through the REAL code paths in lib/deals.ts, so the trigger, the tier
 * derivation, the referral accrual and the leaderboard read exactly what
 * production writes.
 */
const DEALS: DealSeed[] = [
  {
    reporter: "quiet-ledger",
    buyer: "OpenAI",
    askIndex: 0,
    totalUsd: 480_000,
    myShareUsd: 220_000,
    note: "Three-way fill on the household-robotics ask. Unallocated remainder covered teleop rig rental and QA passes.",
    participants: [
      { username: "granite-fox", shareUsd: 180_000, action: "confirm" },
      { username: "vellum", shareUsd: 60_000, action: "confirm" },
    ],
    evidence: [
      {
        username: "quiet-ledger",
        doc: "demo-evidence: settlement statement line 14, robotics trajectories",
        label: "bank statement line, wire credit",
      },
      {
        username: "granite-fox",
        doc: "demo-evidence: countersigned receipt email, robotics trajectories",
        label: "signed receipt email, PDF export",
      },
      {
        username: "vellum",
        doc: "demo-evidence: remittance advice, robotics trajectories",
        label: "remittance advice PDF",
      },
    ],
    roomMessages: [
      { from: "quiet-ledger", body: "Recorded the split as agreed. Hashes are on my row; commit yours when your statements post." },
      { from: "granite-fox", body: "Confirmed and committed. Kept the original PDF in cold storage." },
    ],
    ageDays: 21,
    // Reported on time against a stated close date, and every party pinned
    // evidence: the one deal that earns the timely-recording fee credit, so it
    // shows live on the invites pages of quiet-ledger, granite-fox and vellum.
    statedClose: true,
  },
  {
    reporter: "midnight-audit",
    buyer: "Google DeepMind",
    askIndex: 2,
    totalUsd: 150_000,
    myShareUsd: 95_000,
    note: "First tranche of the ERP trace sessions. Sandbox licensing came out of the total before the split.",
    participants: [{ username: "paper-trail", shareUsd: 40_000, action: "confirm" }],
    evidence: [],
    roomMessages: [
      { from: "paper-trail", body: "Numbers match my invoice. Confirming now." },
    ],
    ageDays: 12,
  },
  {
    reporter: "granite-fox",
    buyer: "Anthropic",
    askIndex: 1,
    totalUsd: 310_000,
    myShareUsd: 85_000,
    note: "Preference-pair delivery, first half. One named party bowed out of the split; their row stands declined.",
    participants: [
      { username: "cold-copy", shareUsd: 120_000, action: "confirm" },
      { username: "midnight-audit", shareUsd: 60_000, action: "confirm" },
      { username: "vellum", shareUsd: 10_000, action: "decline" },
    ],
    evidence: [],
    roomMessages: [
      { from: "vellum", body: "My raters never shipped for this one, declining my row. The rest of the split looks right." },
      { from: "cold-copy", body: "Understood. Confirming mine." },
    ],
    ageDays: 6,
  },
  {
    reporter: "vellum",
    buyer: "Riverbend Data Co-op",
    askIndex: 5,
    totalUsd: 7_500,
    myShareUsd: 7_500,
    note: "Direct sale of the speedrun input streams. Nobody else on the board was involved, so this stays a claim.",
    participants: [],
    evidence: [],
    roomMessages: [],
    ageDays: 3,
  },
  {
    reporter: "cold-copy",
    buyer: "Scale AI",
    askIndex: 9,
    totalUsd: 95_000,
    myShareUsd: 40_000,
    note: "Call-center audio batch one. Split as discussed in the room; confirm when your wires land.",
    participants: [
      { username: "quiet-ledger", shareUsd: 30_000, action: "confirm" },
      { username: "paper-trail", shareUsd: 20_000, action: "pending" },
    ],
    evidence: [],
    roomMessages: [
      { from: "cold-copy", body: "Deal is up with the split from Tuesday. Answer your own rows, please." },
      { from: "quiet-ledger", body: "Wire landed this morning. Confirmed." },
    ],
    // Old enough that paper-trail's still-pending row reads as a chronically
    // pending counterparty on cold-copy's deals (past CHRONIC_PENDING_MS, 30d),
    // so cold-copy carries a live never-confirmed structure signal for its
    // upline to read. Kept under the 60-day settlement grace so it does not
    // also gate cold-copy's posting: this is a signal, not a penalty.
    ageDays: 38,
  },
];

/** SHA-256 hex of a demo document string, standing in for the browser-side file hash. */
function demoEvidenceHash(doc: string): string {
  return createHash("sha256").update(doc, "utf8").digest("hex");
}

/**
 * Cosmetic backdating so the ledger does not read as minted this morning.
 * The rows themselves came from the real code paths above; this only slides
 * every timestamp on the deal (and its room) back by the same delta.
 */
async function backdateDeal(
  db: Awaited<ReturnType<typeof getDb>>,
  dealId: string,
  threadId: string | null,
  ageDays: number,
) {
  const delta = Math.round(ageDays * 24 * 60 * 60 * 1000);
  await db.execute({
    sql: `UPDATE deals SET created_at = created_at - ? WHERE id = ?`,
    args: [delta, dealId],
  });
  await db.execute({
    sql: `UPDATE deal_participants SET confirmed_at = confirmed_at - ?
           WHERE deal_id = ? AND confirmed_at IS NOT NULL`,
    args: [delta, dealId],
  });
  // Slide the stated-close and recorded-at stamps by the same delta: their
  // difference (0) is preserved, so the deal stays inside the timely window,
  // and the close date reads as contemporary with the backdated deal.
  await db.execute({
    sql: `UPDATE deal_close_dates
             SET stated_close_at = stated_close_at - ?, recorded_at = recorded_at - ?
           WHERE deal_id = ?`,
    args: [delta, delta, dealId],
  });
  if (threadId) {
    await db.execute({
      sql: `UPDATE threads
               SET created_at = created_at - ?,
                   last_message_at = CASE WHEN last_message_at > 0
                                          THEN last_message_at - ? ELSE 0 END
             WHERE id = ?`,
      args: [delta, delta, threadId],
    });
    await db.execute({
      sql: `UPDATE messages SET created_at = created_at - ? WHERE thread_id = ?`,
      args: [delta, threadId],
    });
    await db.execute({
      sql: `UPDATE thread_participants
               SET joined_at = joined_at - ?,
                   last_read_at = CASE WHEN last_read_at > 0
                                       THEN last_read_at - ? ELSE 0 END
             WHERE thread_id = ?`,
      args: [delta, delta, threadId],
    });
  }
}

async function main() {
  if (process.env.TURSO_DATABASE_URL) {
    console.log("seed: targeting remote database at TURSO_DATABASE_URL");
  }
  const db = await getDb();

  // Idempotent: clear all rows (children first), then reinsert.
  for (const table of [
    "referral_dispute_status",
    "referral_disputes",
    "referral_settlements",
    "invite_edges",
    "invites",
    "hidden_asks",
    "operators",
    "exchange_wire_claims",
    "exchange_events",
    "exchange_sessions",
    "deal_receipt_signatures",
    "deal_participants",
    "deals",
    "messages",
    "thread_keys",
    "thread_participants",
    "threads",
    "collab_requests",
    "ask_mandates",
    "ask_activity",
    "ask_closures",
    "ask_terms",
    "asks",
    "sessions",
    "user_signing_keys",
    "user_e2ee_keys",
    "users",
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }

  const userIds = new Map<string, string>();
  const userKeys = new Map<string, IdentityKeys>();
  const userSigningKeys = new Map<string, SigningKeys>();
  for (const u of USERS) {
    const created = await createUser(
      u.username,
      DEMO_PASSWORD,
      u.accountType,
      normalizeContact(u.contact),
    );
    if (!created.ok) throw new Error(`seed user ${u.username}: ${created.error}`);
    userIds.set(u.username, created.user.id);
    // The same client-side derivation the signup page runs (lib/e2ee.ts),
    // so signing in as a demo user in a real browser derives the private
    // key that opens the threads seeded below.
    const keys = await deriveIdentityKeys(u.username, DEMO_PASSWORD);
    userKeys.set(u.username, keys);
    await db.execute({
      sql: `INSERT INTO user_e2ee_keys (user_id, pubkey, created_at) VALUES (?, ?, ?)`,
      args: [created.user.id, keys.publicKey, now()],
    });
    // The Ed25519 SIGNING key, registered exactly the way login/signup do it:
    // split off the same e2ee seed (no second scrypt), public half written
    // write-once. This is what lets a demo user party-sign a receipt and sign
    // exchange steps in a real browser, and it is what the receipt + exchange
    // seeding below signs with.
    const signing = signingKeysFromSeed(keys.secretKey, u.username);
    userSigningKeys.set(u.username, signing);
    await db.execute({
      sql: `INSERT INTO user_signing_keys (user_id, pubkey, created_at) VALUES (?, ?, ?)`,
      args: [created.user.id, signing.publicKey, now()],
    });
    console.log(`user  @${created.user.username} (${created.user.accountType})`);
  }

  // Two seeded operators, so /admin and the hide controls are testable
  // locally out of the box: quiet-ledger (the working operator the specs
  // sign in as) and marble-pennant (the genealogy origin). Granted through
  // the REAL grant path (the command-line script is the only writer to the
  // operators table), run as the child process it is in production use.
  {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    for (const handle of ["quiet-ledger", "marble-pennant"]) {
      execFileSync(
        process.execPath,
        [path.join(scriptsDir, "grant-operator.ts"), handle],
        { cwd: path.dirname(scriptsDir), stdio: "inherit" },
      );
    }
  }

  // The invite genealogy, through the REAL paths: every edge is a code the
  // inviter minted (mintInvite, cap and all) and the invitee spent
  // (consumeInvite), so the used-by lists and the referral ledger read
  // exactly what production writes. marble-pennant is the origin, and it seeds
  // TWO sibling branches directly beneath it: quiet-ledger (with midnight-audit
  // and cold-copy under it) and granite-fox (with paper-trail and vellum under
  // it). Two branches on purpose: the sybil-independence rule (lib/independence
  // .ts) discounts a confirmation from a counterparty inside the reporter's own
  // subtree or sharing a NON-root ancestor within two hops, and roots are
  // excluded from that test. So cross-branch co-attestation (quiet-ledger's
  // branch confirming granite-fox's, and back) shares only the root and counts
  // in full, giving the leaderboard real collaborator and value-to-others
  // figures; a confirmation WITHIN one branch (cold-copy's deal confirmed by
  // its own inviter quiet-ledger, deal 5 below) shares a non-root ancestor and
  // is reputation-discounted, the rule visible on seed data. If the whole
  // member tree hung under one non-root hub instead, every pair would share it
  // and the entire brought-in board would zero out. attic-lantern (created
  // below) deliberately keeps NO edge: the grandfathered pre-invite account.
  const EDGES: [inviter: string, invitee: string][] = [
    ["marble-pennant", "quiet-ledger"],
    ["marble-pennant", "granite-fox"],
    ["quiet-ledger", "midnight-audit"],
    ["quiet-ledger", "cold-copy"],
    ["granite-fox", "paper-trail"],
    ["granite-fox", "vellum"],
  ];
  for (const [inviter, invitee] of EDGES) {
    const minted = await mintInvite(userIds.get(inviter)!);
    if (!minted.ok) throw new Error(`seed invite mint by ${inviter}: ${minted.error}`);
    const spent = await consumeInvite(minted.code, userIds.get(invitee)!);
    if (!spent.ok) throw new Error(`seed invite spend for ${invitee}: ${spent.error}`);
  }
  // A few unused codes for every seeded member, the operators included, so
  // signup is exercisable against seed data out of the box.
  for (const u of USERS) {
    for (let i = 0; i < 3; i++) {
      const minted = await mintInvite(userIds.get(u.username)!);
      if (!minted.ok) throw new Error(`seed spare invite for ${u.username}: ${minted.error}`);
    }
  }
  // Extra codes from the ROOT operator. The deals suite signs its three test
  // accounts up on marble-pennant codes on purpose: children of the root share
  // only the root, so the independence rule (which excludes roots) leaves them
  // sybil-INDEPENDENT of each other, and the suite's exact leaderboard figures
  // are the un-discounted tier-weighted ones. Minted through the real path; the
  // count is headroom above the three that suite spends.
  for (let i = 0; i < 3; i++) {
    const minted = await mintInvite(userIds.get("marble-pennant")!);
    if (!minted.ok) throw new Error(`seed extra root invite: ${minted.error}`);
  }
  console.log(
    `invites: ${EDGES.length} edges recorded (origin marble-pennant), ` +
      `${USERS.length * 3 + 3} unused codes minted`,
  );

  const day = 24 * 60 * 60 * 1000;
  const askIds: string[] = [];
  for (const a of ASKS) {
    const token = await serverMintBuyerTokenV2(a.buyer); // the name dies right here
    const askId = newId("ask");
    askIds.push(askId);
    await db.execute({
      sql: `INSERT INTO asks
              (id, user_id, title, category, description, modality_tags, volume,
               price_band, supply_filled_pct, buyer_token, buyer_is_other, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        askId,
        userIds.get(a.user)!,
        a.title,
        a.category,
        a.description,
        packTags(a.tags),
        a.volume,
        a.priceBand,
        a.filledPct,
        token,
        isKnownBuyer(a.buyer) ? 0 : 1,
        a.status,
        now() - a.ageDays * day,
      ],
    });

    // Terms, stated with the post like the compose form does. The one null
    // stays a legacy "terms unspecified" ask.
    if (a.exclusivity !== null) {
      await db.execute({
        sql: `INSERT INTO ask_terms (ask_id, exclusivity) VALUES (?, ?)`,
        args: [askId, a.exclusivity],
      });
    }

    // The autoclose clock. Posting is the first affirmation; a few asks
    // carry a fresher one (with the note the ask page shows), and the
    // pre-aged ask keeps its stale posting-time affirmation on purpose.
    const affirmedAt = now() - (a.affirmedDaysAgo ?? a.ageDays) * day;
    await db.execute({
      sql: `INSERT INTO ask_activity (ask_id, affirmed_at, note) VALUES (?, ?, ?)`,
      args: [askId, affirmedAt, a.updateNote ?? ""],
    });

    // The seeded closed ask closed the owner way: filled to 100.
    if (a.status === "closed") {
      await db.execute({
        sql: `INSERT INTO ask_closures (ask_id, reason, closed_at) VALUES (?, 'owner', ?)`,
        args: [askId, now() - a.ageDays * day],
      });
    }

    console.log(`ask   ${a.title.slice(0, 56)} -> Buyer #${buyerChip(token)}`);
  }

  // Mandate commitments for two asks, through the REAL write-once path
  // (lib/mandates.ts), owner check and all. One is backdated to the ask's
  // own posting time (pinned with the post); the other keeps its true
  // commit stamp, so the ask page's honesty line demonstrates a visibly
  // late pin against the backdated posting date.
  {
    const withPost = 1; // granite-fox, contested-topic preference pairs
    const m1 = await commitMandate(askIds[withPost], userIds.get(ASKS[withPost].user)!, {
      docHash: demoEvidenceHash("demo-mandate: buyer RFP, contested-topic preference pairs, rev 3"),
      label: "buyer RFP, rev 3, PDF",
    });
    if (!m1.ok) throw new Error(`seed mandate (with post): ${m1.error}`);
    await db.execute({
      sql: `UPDATE ask_mandates
               SET committed_at = (SELECT created_at FROM asks WHERE id = ?)
             WHERE ask_id = ?`,
      args: [askIds[withPost], askIds[withPost]],
    });

    const late = 2; // midnight-audit, ERP agent traces, posted days earlier
    const m2 = await commitMandate(askIds[late], userIds.get(ASKS[late].user)!, {
      docHash: demoEvidenceHash("demo-mandate: buyer email thread export, ERP agent traces"),
      label: "buyer email thread export",
    });
    if (!m2.ok) throw new Error(`seed mandate (late): ${m2.error}`);
    console.log("mandates: 2 asks pinned (one with the post, one visibly late)");
  }

  const dealIds: string[] = [];
  for (const d of DEALS) {
    const reporterId = userIds.get(d.reporter)!;
    const token = await serverMintBuyerTokenV2(d.buyer); // same rule as asks
    const created = await createDeal(reporterId, d.reporter, {
      buyerToken: token,
      buyerIsOther: !isKnownBuyer(d.buyer),
      askId: d.askIndex == null ? null : askIds[d.askIndex],
      totalUsd: d.totalUsd,
      myShareUsd: d.myShareUsd,
      note: d.note,
      // Stated at recording time (diff 0), so it stays timely after backdating.
      statedCloseAt: d.statedClose ? now() : null,
      participants: d.participants.map((p) => ({
        username: p.username,
        shareUsd: p.shareUsd,
      })),
    });
    if (!created.ok) throw new Error(`seed deal (${d.reporter}): ${created.error}`);
    dealIds.push(created.dealId);

    // End-to-end encrypt the deal room exactly the way a browser does it:
    // random thread key, wrapped for every seat against each demo user's
    // password-derived public key, then every message sealed BEFORE it
    // reaches appendMessage, which by now refuses plaintext in this thread.
    if (created.threadId) {
      const threadKey = generateThreadKey();
      const seats = [d.reporter, ...d.participants.map((p) => p.username)];
      for (const username of seats) {
        const wrapped = await wrapThreadKey(
          threadKey,
          userKeys.get(username)!.publicKey,
          created.threadId,
        );
        if (!wrapped) throw new Error(`seed thread-key wrap for @${username} failed`);
        await db.execute({
          sql: `INSERT INTO thread_keys (thread_id, user_id, wrapped_key, eph_pubkey, created_at)
                VALUES (?, ?, ?, ?, ?)`,
          args: [
            created.threadId,
            userIds.get(username)!,
            wrapped.wrappedKey,
            wrapped.ephPubkey,
            now(),
          ],
        });
      }
      for (const m of d.roomMessages) {
        const sealed = await sealMessage(threadKey, created.threadId, m.body);
        const sent = await appendMessage(created.threadId, userIds.get(m.from)!, sealed);
        if (!sent.ok) throw new Error(`seed deal-room message: ${sent.error}`);
      }
    }

    for (const p of d.participants) {
      if (p.action === "pending") continue;
      const act =
        p.action === "confirm"
          ? await confirmDealShare(created.dealId, userIds.get(p.username)!)
          : await declineDealShare(created.dealId, userIds.get(p.username)!);
      if (!act.ok) throw new Error(`seed ${p.action} @${p.username}: ${act.error}`);
    }

    for (const e of d.evidence) {
      const committed = await commitEvidence(
        created.dealId,
        userIds.get(e.username)!,
        demoEvidenceHash(e.doc),
        e.label,
      );
      if (!committed.ok) {
        throw new Error(`seed evidence @${e.username}: ${committed.error}`);
      }
    }

    await backdateDeal(db, created.dealId, created.threadId, d.ageDays);
    console.log(
      `deal  $${d.totalUsd.toLocaleString("en-US")} -> Buyer #${buyerChip(token)}, ` +
        `${d.participants.length} named, reported by @${d.reporter}`,
    );
  }

  // Referral settlements, through the REAL recording path: the payee (the
  // creditor) writes down money received off the platform; the payer
  // confirms one of them, and the other stays visibly one-sided. Amounts
  // are integer cents and match the accruals the ledger derives from the
  // deals above: vellum's $60k confirmed share accrues $1,500 gross to
  // granite-fox at depth 1, less the 20% timely-recording credit deal 0
  // earns (evidence pinned, stated close date), so $1,200 net; cold-copy's
  // $120k on the credit-free deal 3 accrues the full $3,000 to quiet-ledger.
  {
    const s1 = await recordSettlement(
      userIds.get("granite-fox")!,
      "vellum",
      1_200_00,
      "wire against invoice 7",
    );
    if (!s1.ok) throw new Error(`seed settlement (vellum -> granite-fox): ${s1.error}`);
    const c1 = await confirmSettlement(s1.id, userIds.get("vellum")!);
    if (!c1.ok) throw new Error(`seed settlement confirm: ${c1.error}`);

    const s2 = await recordSettlement(
      userIds.get("quiet-ledger")!,
      "cold-copy",
      3_000_00,
      "cash, receipt kept both sides",
    );
    if (!s2.ok) throw new Error(`seed settlement (cold-copy -> quiet-ledger): ${s2.error}`);
    console.log("referrals: 2 settlements recorded (one payer-confirmed)");
  }

  // One PRE-E2EE thread, kept deliberately. @attic-lantern is an account
  // from before message encryption shipped and has not signed in since, so
  // it has no user_e2ee_keys row; a thread seating it cannot be encrypted
  // and the UI labels it "not end-to-end encrypted". Created the way such
  // threads really came to exist: an accepted collab on quiet-ledger's
  // merged-PR ask, messages appended through the same store the routes use
  // (which accepts plaintext exactly because this thread has no keys).
  {
    const legacy = await createUser(
      "attic-lantern",
      DEMO_PASSWORD,
      "individual",
      normalizeContact("seed-attic-lantern@example.com"),
    );
    if (!legacy.ok) throw new Error(`seed user attic-lantern: ${legacy.error}`);
    const legacyId = legacy.user.id;
    // Grandfathered accounts still get to vouch: a couple of codes through
    // the real mint path, even though nobody is recorded above this one.
    for (let i = 0; i < 2; i++) {
      const minted = await mintInvite(legacyId);
      if (!minted.ok) throw new Error(`seed spare invite for attic-lantern: ${minted.error}`);
    }
    const askId = askIds[6]; // "Merged-PR triplets from private monorepos"
    const ownerId = userIds.get("quiet-ledger")!;
    const threadId = newId("thr");
    const t = now() - 40 * day;
    await db.execute({
      sql: `INSERT INTO collab_requests (id, ask_id, requester_id, note, status, created_at)
            VALUES (?, ?, ?, ?, 'accepted', ?)`,
      args: [
        newId("clb"),
        askId,
        legacyId,
        "Sitting on review-thread exports from two retired monorepos. Happy to compare license chains.",
        t,
      ],
    });
    await db.execute({
      sql: `INSERT INTO threads (id, ask_id, subject, created_at, last_message_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [threadId, askId, "Merged-PR triplets from private monorepos", t, t],
    });
    for (const uid of [ownerId, legacyId]) {
      await db.execute({
        sql: `INSERT INTO thread_participants (thread_id, user_id, joined_at, last_read_at)
              VALUES (?, ?, ?, ?)`,
        args: [threadId, uid, t, t],
      });
    }
    const legacyMessages: { from: string; body: string }[] = [
      {
        from: "attic-lantern",
        body: "License chains are documented for both archives. Which review-thread format do you ingest?",
      },
      {
        from: "quiet-ledger",
        body: "Plain diff plus threaded comments works. Send a five-item sample when ready.",
      },
    ];
    for (const m of legacyMessages) {
      const sent = await appendMessage(
        threadId,
        m.from === "quiet-ledger" ? ownerId : legacyId,
        m.body,
      );
      if (!sent.ok) throw new Error(`seed legacy message: ${sent.error}`);
    }
    await db.execute({
      sql: `UPDATE threads SET created_at = ?, last_message_at = ? WHERE id = ?`,
      args: [t, t, threadId],
    });
    await db.execute({
      sql: `UPDATE messages SET created_at = ? WHERE thread_id = ?`,
      args: [t, threadId],
    });
    console.log(`thread legacy pre-E2EE plaintext room for @attic-lantern (no e2ee key)`);
  }

  // Party-signed receipt on a co-attested deal (Feature 1). Deal index 2 is
  // granite-fox's Anthropic preference-pair deal, co-attested by cold-copy and
  // midnight-audit (vellum's row is declined and so is off the roster). Minting
  // its logged receipt fixes the receipt_minted translog seq the signatures
  // commit to; every confirmed party then signs the canonical receipt bytes
  // with the SAME Ed25519 key their password derives (registered above), the
  // exact bytes the browser sign button and /receipts/verify recompute. The
  // server stores only the signatures: a co-attested receipt the operator
  // cannot forge, because it holds no party key.
  {
    const dealId = dealIds[2];
    const deal = await getDealForUser(dealId, userIds.get("granite-fox")!);
    if (!deal) throw new Error("seed receipt: co-attested deal not found");
    const logged = await loggedReceiptForDeal(deal);
    if (!logged || !logged.payload.log) {
      throw new Error("seed receipt: deal did not mint a log-bound receipt");
    }
    const fields = partyBaseFieldsFromPayload(logged.payload);
    if (!fields || fields.signers.length < 2) {
      throw new Error("seed receipt: expected a multi-party signer roster");
    }
    const base = partySigningBase(fields);
    for (const signer of fields.signers) {
      const signing = userSigningKeys.get(signer.handle);
      if (!signing) throw new Error(`seed receipt: no signing key for @${signer.handle}`);
      const sig = signReceiptBase(base, signing.secretKey);
      const stored = await storePartySig({
        dealId: deal.id,
        userId: userIds.get(signer.handle)!,
        seq: fields.seq,
        pubkey: signing.publicKey,
        sig,
        now: now(),
      });
      if (!stored.ok) throw new Error(`seed receipt sig @${signer.handle}: ${stored.error}`);
    }
    console.log(
      `receipt: co-attested deal party-signed by ${fields.signers.length} parties ` +
        `(${fields.signers.map((s) => "@" + s.handle).join(", ")}) at seq ${fields.seq}`,
    );
  }

  // A commit-encrypt-pay-reveal exchange session, stood up PARTWAY through the
  // steps so the /deals/[id]/exchange UI renders a live, mid-flight handoff
  // (Feature 3). Deal index 0 (quiet-ledger's OpenAI robotics deal) between the
  // reporter as SELLER and granite-fox as BUYER, both confirmed. Driven through
  // the REAL store functions, so every leaf is Ed25519-signed by the acting
  // party and hash-linked exactly as a browser would post it: seller commits
  // (roots + DEK commitment, never the data or the key), the demo ciphertext
  // blob is uploaded as opaque bytes, the buyer acks the ciphertext root and
  // commits its PAYMENT_SENT proof (a salted hash of a wire confirmation, the
  // amount bucket and this deal's wire reference N15). Then the upgraded,
  // mutually-signed pay step (Feature 1): the seller observes the inbound credit
  // and signs the WireCreditClaim (a salted commitment to its receiving-bank
  // record + an account nullifier, never a bank name or account number), and the
  // buyer countersigns. It stops at payment_signaled with the wire claim
  // wire_credit_observed, so the page renders a countersigned proof-of-payment
  // and the deal feeds the verified-amount weighting; the seller's key reveal is
  // the next move.
  {
    const dealId = dealIds[0];
    const sellerName = "quiet-ledger";
    const buyerName = "granite-fox";
    const seller = { id: userIds.get(sellerName)!, username: sellerName };
    const buyer = { id: userIds.get(buyerName)!, username: buyerName };
    const sellerSigning = userSigningKeys.get(sellerName)!;
    const buyerSigning = userSigningKeys.get(buyerName)!;

    const signInput = (leaf: ExchangeLeaf, signing: SigningKeys): SignedEventInput => ({
      leaf,
      eventHash: eventHash(leaf),
      signature: signLeaf(leaf, signing.secretKey),
      signerPubkey: signing.publicKey,
    });

    const sessionId = newSessionId();
    const dek = generateDek();
    const dekSalt = new Uint8Array(randomBytes(16));
    const nonce = wireNonce();
    const n15 = n15Of(dealId, nonce);
    const dataset = new TextEncoder().encode(
      "demo dataset (synthetic): 8 household-robotics episodes, sensor+3d, off-platform in production",
    );
    const enc = await encryptDataset(sessionId, dataset, dek);
    const dekCommit = dekCommitHex(dealId, dekSalt, dek);

    const commitLeaf: ExchangeLeaf = {
      v: EXCHANGE_VERSION,
      sessionId,
      dealId,
      seq: 1,
      type: "commit",
      actorRole: "seller",
      actor: sellerName,
      prevHash: GENESIS_PREV_HASH,
      ts: now(),
      data: {
        plaintextRoot: enc.plaintextRoot,
        ciphertextRoot: enc.ciphertextRoot,
        dekCommit,
        dekSalt: toB64url(dekSalt),
        chunkCount: enc.chunkCount,
        chunkSize: enc.chunkSize,
        sizeBucket: enc.sizeBucket,
        buyer: buyerName,
        n15,
        wireNonceCommit: wireNonceCommitHex(dealId, new Uint8Array(randomBytes(16)), nonce),
      },
    };
    const committed = await createExchangeSession(seller, signInput(commitLeaf, sellerSigning));
    if (!committed.ok) throw new Error(`seed exchange commit: ${committed.error}`);

    // The seller hands the buyer the sealed chunks. In production these move
    // off-platform; the demo carries them as an opaque, size-capped blob the
    // server treats as bytes it cannot read.
    const blob = await setDemoBlob(sessionId, seller.id, toB64url(enc.ciphertext));
    if (!blob.ok) throw new Error(`seed exchange blob: ${blob.error}`);

    let head = committed.value;
    const ackLeaf: ExchangeLeaf = {
      v: EXCHANGE_VERSION,
      sessionId,
      dealId,
      seq: head.headSeq + 1,
      type: "ciphertext_ack",
      actorRole: "buyer",
      actor: buyerName,
      prevHash: head.headHash,
      ts: now(),
      data: { ciphertextRoot: enc.ciphertextRoot },
    };
    const acked = await appendExchangeEvent(buyer, sessionId, signInput(ackLeaf, buyerSigning));
    if (!acked.ok) throw new Error(`seed exchange ciphertext_ack: ${acked.error}`);

    head = acked.value;
    const paySalt = new Uint8Array(randomBytes(16));
    const payLeaf: ExchangeLeaf = {
      v: EXCHANGE_VERSION,
      sessionId,
      dealId,
      seq: head.headSeq + 1,
      type: "payment_signaled",
      actorRole: "buyer",
      actor: buyerName,
      prevHash: head.headHash,
      ts: now(),
      data: {
        paymentCommit: paymentCommitHex(paySalt, "wire ref demo-0001"),
        method: "wire",
        n15,
        amountBucket: "$200k",
      },
    };
    const paid = await appendExchangeEvent(buyer, sessionId, signInput(payLeaf, buyerSigning));
    if (!paid.ok) throw new Error(`seed exchange payment_signaled: ${paid.error}`);

    // The WireCreditClaim (Feature 1) rides its own hash-linked chain anchored to
    // the payment_signaled event. seq 1 is the seller's claim; seq 2 is the
    // buyer's countersign, which reaches wire_credit_observed. Everything the
    // browser would hash locally (bank record, receiving account, UETR) is hashed
    // here too, so the server row carries commitments and buckets only.
    const signWireInput = (leaf: WireClaimLeaf, signing: SigningKeys): SignedEventInput => ({
      leaf: leaf as unknown as ExchangeLeaf,
      eventHash: eventHash(leaf),
      signature: signLeaf(leaf, signing.secretKey),
      signerPubkey: signing.publicKey,
    });

    const claimLeaf: WireClaimLeaf = {
      v: EXCHANGE_VERSION,
      sessionId,
      dealId,
      seq: 1,
      type: "wire_credit_claim",
      actorRole: "seller",
      actor: sellerName,
      prevHash: paid.value.wireAnchorHash!,
      ts: now(),
      data: {
        n15,
        rail: "WIRE",
        amountBucket: "$200k",
        terminalStatus: WIRE_TERMINAL_STATUSES[0],
        valueTime: now(),
        bankRecordCommit: wireRecordCommitHex(
          new Uint8Array(randomBytes(16)),
          new TextEncoder().encode("demo credit advice (synthetic): inbound wire, robotics trajectories"),
        ),
        accountNullifier: accountNullifierHex(sellerName, "demo-receiving-account-0001"),
        uetrCommit: uetrCommitHex(new Uint8Array(randomBytes(16)), "demo-uetr-0001"),
        schemaVersion: WIRE_CLAIM_VERSION,
      },
    };
    const claimed = await appendWireClaim(seller, sessionId, signWireInput(claimLeaf, sellerSigning));
    if (!claimed.ok) throw new Error(`seed exchange wire_credit_claim: ${claimed.error}`);

    const claimHash = eventHash(claimLeaf);
    const counterLeaf: WireClaimLeaf = {
      v: EXCHANGE_VERSION,
      sessionId,
      dealId,
      seq: 2,
      type: "wire_credit_countersign",
      actorRole: "buyer",
      actor: buyerName,
      prevHash: claimHash,
      ts: now(),
      data: { claimHash, n15, accept: true },
    };
    const observed = await appendWireClaim(buyer, sessionId, signWireInput(counterLeaf, buyerSigning));
    if (!observed.ok) throw new Error(`seed exchange wire_credit_countersign: ${observed.error}`);

    console.log(
      `exchange: ${sessionId} on deal 0, seller @${sellerName} buyer @${buyerName}, ` +
        `state ${observed.value.state} wire ${observed.value.wireStatus} ref ${n15} ` +
        `(countersigned proof-of-payment; seller reveals the key next)`,
    );
  }

  // Transparency log checkpoints. Every consequential write above already
  // appended a leaf (deals, confirmations, tiers, invites, referral settled);
  // here we sign and cache a few Signed Tree Heads at intermediate sizes so the
  // /transparency/log checkpoint history shows more than one anchored size out
  // of the box, and a visitor can run a consistency proof BETWEEN two of them
  // (proving the smaller tree is an exact prefix of the larger). The heads are a
  // pure function of the leaves; caching them writes nothing an on-demand read
  // would not have written the first time either surface is loaded.
  {
    const rs = await db.execute(`SELECT COUNT(*) AS n FROM translog_leaves`);
    const size = Number(rs.rows[0]?.n ?? 0);
    if (size > 0) {
      const sizes = [...new Set(
        [Math.ceil(size / 3), Math.ceil((2 * size) / 3), size].filter((s) => s >= 1),
      )].sort((a, b) => a - b);
      for (const s of sizes) await getSignedHead(s);
      console.log(`translog: ${size} leaves, checkpoints signed at ${sizes.join(", ")}`);
    }
  }

  console.log(
    `\nseeded ${USERS.length + 1} users, ${ASKS.length} asks and ${DEALS.length} deals. ` +
      `Sign in as any of them with password "${DEMO_PASSWORD}".`,
  );
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
