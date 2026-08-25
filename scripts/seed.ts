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

import { createHash } from "node:crypto";
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
import { appendMessage } from "../app/api/threads/store.ts";
import {
  deriveIdentityKeys,
  generateThreadKey,
  sealMessage,
  wrapThreadKey,
  type IdentityKeys,
} from "../lib/e2ee.ts";

const DEMO_PASSWORD = "demo-demo-demo";

const USERS = [
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
};

/**
 * Five demo deals, exercising every state the ledger and leaderboard render:
 * one evidence-committed (tier 2), two co-attested (one with a declined
 * share, which counts nowhere), one solo claim, one still pending with a
 * live deal room. Created through the REAL code paths in lib/deals.ts, so
 * the trigger, the tier derivation and the leaderboard read exactly what
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
    ageDays: 1,
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
    "hidden_asks",
    "operators",
    "deal_participants",
    "deals",
    "messages",
    "thread_keys",
    "thread_participants",
    "threads",
    "collab_requests",
    "ask_mandates",
    "asks",
    "sessions",
    "user_e2ee_keys",
    "users",
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }

  const userIds = new Map<string, string>();
  const userKeys = new Map<string, IdentityKeys>();
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
    console.log(`user  @${created.user.username} (${created.user.accountType})`);
  }

  // One seeded operator, so /admin and the hide controls are testable
  // locally out of the box. Granted through the REAL grant path (the
  // command-line script is the only writer to the operators table), run as
  // the child process it is in production use.
  {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    execFileSync(
      process.execPath,
      [path.join(scriptsDir, "grant-operator.ts"), "quiet-ledger"],
      { cwd: path.dirname(scriptsDir), stdio: "inherit" },
    );
  }

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
      participants: d.participants.map((p) => ({
        username: p.username,
        shareUsd: p.shareUsd,
      })),
    });
    if (!created.ok) throw new Error(`seed deal (${d.reporter}): ${created.error}`);

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
