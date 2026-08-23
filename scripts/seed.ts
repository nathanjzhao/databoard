/**
 * scripts/seed.ts
 *
 * Demo data, created through the REAL code paths: users via createUser() (so
 * password hashing and contact blind-indexing behave exactly as signup does)
 * and asks via buyerToken() (so the blind buyer tokens on the board are the
 * same ones the compose form would mint, and equal names collide the way
 * they should).
 *
 * Run with: npm run seed        (plain node, type stripping, no bundler)
 * Every demo account's password is "demo-demo-demo".
 */

import { createHash } from "node:crypto";
import { closeDb, getDb, now } from "../lib/db.ts";
import { createUser } from "../lib/auth.ts";
import { buyerToken, newId, normalizeContact } from "../lib/crypto.ts";
import { isKnownBuyer } from "../lib/buyers.ts";
import { packTags } from "../lib/taxonomy.ts";
import {
  commitEvidence,
  confirmDealShare,
  createDeal,
  declineDealShare,
} from "../lib/deals.ts";
import { appendMessage } from "../app/api/threads/store.ts";

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
    "deal_participants",
    "deals",
    "messages",
    "thread_participants",
    "threads",
    "collab_requests",
    "asks",
    "sessions",
    "users",
  ]) {
    await db.execute(`DELETE FROM ${table}`);
  }

  const userIds = new Map<string, string>();
  for (const u of USERS) {
    const created = await createUser(
      u.username,
      DEMO_PASSWORD,
      u.accountType,
      normalizeContact(u.contact),
    );
    if (!created.ok) throw new Error(`seed user ${u.username}: ${created.error}`);
    userIds.set(u.username, created.user.id);
    console.log(`user  @${created.user.username} (${created.user.accountType})`);
  }

  const day = 24 * 60 * 60 * 1000;
  const askIds: string[] = [];
  for (const a of ASKS) {
    const token = buyerToken(a.buyer); // the name dies right here, same as prod
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
    console.log(`ask   ${a.title.slice(0, 56)} -> Buyer #${token.slice(0, 4)}`);
  }

  for (const d of DEALS) {
    const reporterId = userIds.get(d.reporter)!;
    const token = buyerToken(d.buyer); // same rule as asks: keyed, then gone
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

    for (const m of d.roomMessages) {
      if (!created.threadId) break;
      const sent = await appendMessage(created.threadId, userIds.get(m.from)!, m.body);
      if (!sent.ok) throw new Error(`seed deal-room message: ${sent.error}`);
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
      `deal  $${d.totalUsd.toLocaleString("en-US")} -> Buyer #${token.slice(0, 4)}, ` +
        `${d.participants.length} named, reported by @${d.reporter}`,
    );
  }

  console.log(
    `\nseeded ${USERS.length} users, ${ASKS.length} asks and ${DEALS.length} deals. ` +
      `Sign in as any of them with password "${DEMO_PASSWORD}".`,
  );
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
