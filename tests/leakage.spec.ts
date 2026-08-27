/**
 * tests/leakage.spec.ts
 *
 * The five referral-fee-evasion holes an adversarial review found, each proven
 * CLOSED, and each with a deliberate-failure counterfactual: every test also
 * computes what the OLD (broken) code would have done, so a green line here is
 * a guard that would have gone red before the fix, not a tautology.
 *
 * The core principle the fixes restore: the predicate that GRANTS reputation
 * and the predicate that CHARGES the fee must be the SAME predicate, so no
 * structuring buys standing while dodging the 2.5%.
 *
 *   H1 pending-sock poison pill   accrual fires on a confirmed party even when
 *                                 another named party never confirms
 *   H2 solo-claim structuring     a unilateral claim earns ZERO ranked value
 *   H3 fee-free rootless nodes     every confirmed share owes the depth-1 floor;
 *                                 a rootless earner owes it to the house
 *   H4 contact canonicalization    gmail aliases of one inbox collapse to one
 *                                 blind index
 *   H5 dispute resolution          a raised dispute lifts the gate for a bounded
 *                                 window or until an operator rules, never forever
 *   PRIVACY                        the affected/new tables hold tokens and
 *                                 integers, never PII; canonicalization stores
 *                                 the blind index, never the address
 *
 * Method, following the builders' own ledgerProbe / disputeLifecycleProbe: the
 * logic tests run the REAL lib (lib/referrals.ts, lib/stats.ts, lib/deals.ts,
 * lib/auth.ts, lib/crypto.ts) inside a node subprocess against a THROWAWAY
 * database, so the assertion covers the shipped implementation's arithmetic and
 * touches nothing in the shared app.db. The one live-server slice (H5's admin
 * API) is read-only. Nothing here mutates app.db, so the suite is order-safe
 * against the other eight.
 *
 * PRECONDITION: the same fresh reset + seed + started server as every suite.
 */

import {
  test,
  expect,
  request as pwRequest,
  type APIRequestContext,
} from "@playwright/test";
import { createClient, type Client } from "@libsql/client";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
const PORT = Number(process.env.PW_PORT ?? 3947);
const BASE = `http://localhost:${PORT}`;
const DEMO_PASSWORD = "demo-demo-demo";

/* --------------------------------------------------------- throwaway probe */

/**
 * Boilerplate wrapped around every probe body: spin up a private sqlite file
 * via BLIND_TENDER_DB, load the real lib modules, expose a couple of graph
 * builders, run `body` (which fills `out`), print `out` as one JSON line, and
 * delete the file. The parent reads only stdout, so the module-type warning
 * that type-stripping prints to stderr is harmless. Identical ethos to
 * tests/invites.spec.ts's disputeLifecycleProbe.
 */
const PREAMBLE = `
(async () => {
  const os = await import("node:os");
  const fsp = await import("node:fs");
  const pathm = await import("node:path");
  const tmp = pathm.join(os.tmpdir(), "leak-" + LABEL + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".db");
  for (const s of ["", "-journal", "-wal", "-shm"]) { try { fsp.rmSync(tmp + s); } catch {} }
  process.env.BLIND_TENDER_DB = "file:" + tmp;
  delete process.env.TURSO_DATABASE_URL;
  const dbmod = await import("./lib/db.ts");
  const ref = await import("./lib/referrals.ts");
  const stats = await import("./lib/stats.ts");
  const deals = await import("./lib/deals.ts");
  const auth = await import("./lib/auth.ts");
  const crypto = await import("./lib/crypto.ts");
  const db = await dbmod.getDb();
  const now = dbmod.now;
  const nid = crypto.newId;
  const DAY = 24 * 60 * 60 * 1000;
  const cleanup = () => { for (const s of ["", "-journal", "-wal", "-shm"]) { try { fsp.rmSync(tmp + s); } catch {} } };
  async function mkuser(name, op) {
    const id = nid("usr");
    await db.execute({ sql: "INSERT INTO users (id, username, password_hash, account_type, contact_blind_index, created_at) VALUES (?,?,?,?,?,?)", args: [id, name, "x", "individual", "bi_" + name, now()] });
    if (op) await db.execute({ sql: "INSERT INTO operators (user_id, granted_at) VALUES (?,?)", args: [id, now()] });
    return id;
  }
  async function edge(child, inviter) {
    await db.execute({ sql: "INSERT INTO invite_edges (user_id, inviter_id, invite_code, created_at) VALUES (?,?,?,?)", args: [child, inviter, "inv_" + child.slice(0, 6), now()] });
  }
  const out = {};
`;

const EPILOGUE = `
  dbmod.closeDb();
  cleanup();
  console.log(LABEL + "::" + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
`;

function runProbe(label: string, body: string): Record<string, unknown> {
  const script = `const LABEL = ${JSON.stringify(label)};\n` + PREAMBLE + body + EPILOGUE;
  const stdout = execFileSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env },
  });
  const line = stdout.split("\n").find((l) => l.startsWith(label + "::"));
  expect(line, `${label} probe produced output`).toBeTruthy();
  return JSON.parse(line!.slice((label + "::").length));
}

/* ------------------------------------------------------------- db helper */

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = createClient({ url: `file:${DB_PATH}` });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

test.describe.configure({ mode: "serial" });

/* ------------------------------------------------------- 1 H1 POISON PILL */

/**
 * A confirmed share must accrue even when another named party on the deal
 * never confirms. Two identical earners under one inviter: earner-sock's deal
 * carries an eternally-pending sock participant, earner-clean's does not. The
 * real ledger must charge both the same 2.5%. The counterfactual reruns the
 * OLD predicate (AND NOT EXISTS a pending participant) in raw SQL and shows it
 * zeroed the sock deal while the leaderboard still credited the reputation:
 * the exact fee-free-reputation asymmetry the review flagged.
 */
test("01 H1 POISON PILL: an eternally-pending sock participant no longer zeroes referral accrual", () => {
  const r = runProbe(
    "h1",
    `
    const MP = await mkuser("marble-pennant", true);
    const I  = await mkuser("inviter-1"); await edge(I, MP);
    const E1 = await mkuser("earner-sock");  await edge(E1, I);
    const E2 = await mkuser("earner-clean"); await edge(E2, I);
    const X1 = await mkuser("reporter-1");
    const X2 = await mkuser("reporter-2");
    await mkuser("sockpuppet");

    // Deal A: earner-sock confirms a 50k share; a share-0 sock stays pending forever.
    const dA = await deals.createDeal(X1, "reporter-1", { buyerToken: "v2:0", buyerIsOther: false, askId: null, totalUsd: 100000, myShareUsd: 0, note: "", participants: [{ username: "earner-sock", shareUsd: 50000 }, { username: "sockpuppet", shareUsd: 0 }] });
    await deals.confirmDealShare(dA.dealId, E1);
    // Deal B: earner-clean confirms an identical 50k share, no sock.
    const dB = await deals.createDeal(X2, "reporter-2", { buyerToken: "v2:0", buyerIsOther: false, askId: null, totalUsd: 100000, myShareUsd: 0, note: "", participants: [{ username: "earner-clean", shareUsd: 50000 }] });
    await deals.confirmDealShare(dB.dealId, E2);

    // NEW behaviour: the real ledger, read through computeReferralLedger.
    const L = await ref.computeReferralLedger(I);
    out.newSock  = L.downline.find((d) => d.username === "earner-sock").accruedCents;
    out.newClean = L.downline.find((d) => d.username === "earner-clean").accruedCents;

    // OLD behaviour: the pre-fix earningEventsFor predicate, replayed verbatim.
    async function oldAccrual(uid) {
      const rs = await db.execute({ sql: "SELECT p.share_usd FROM deal_participants p WHERE p.user_id=? AND p.status='confirmed' AND p.share_usd>0 AND EXISTS(SELECT 1 FROM deal_participants q WHERE q.deal_id=p.deal_id AND q.role='participant' AND q.status='confirmed') AND NOT EXISTS(SELECT 1 FROM deal_participants q WHERE q.deal_id=p.deal_id AND q.role='participant' AND q.status='pending')", args: [uid] });
      return rs.rows.reduce((s, x) => s + ref.accrualCents(Number(x.share_usd), 1), 0);
    }
    out.oldSock  = await oldAccrual(E1);
    out.oldClean = await oldAccrual(E2);

    // Reputation lands on the sock deal regardless: earner-sock's own value.
    const lb = await stats.computeLeaderboard();
    out.repSock = lb.rows.find((x) => x.username === "earner-sock").valueToSelfUsd;
  `,
  );

  // 2.5% of $50,000 = $1,250 = 125000 cents, and the sock deal equals the clean one.
  expect(r.newSock).toBe(125000);
  expect(r.newClean).toBe(125000);
  expect(r.newSock, "the sock no longer poisons: accrual equals the sockless deal").toBe(r.newClean);

  // Counterfactual: the OLD predicate zeroed the sock deal, kept the clean one.
  expect(r.oldSock, "the old NOT-EXISTS-pending clause zeroed the poisoned deal").toBe(0);
  expect(r.oldClean).toBe(125000);

  // The asymmetry the hole rode: reputation ($50k) landed while the old fee was $0.
  expect(r.repSock).toBe(50000);
});

/* -------------------------------------------------------- 2 H2 SOLO CLAIM */

/**
 * A unilateral claim earns nothing on the ranked board. acct-a co-attests a
 * $30k deal (its real ranked value) and separately claims a $500k solo deal;
 * acct-b co-attests $200k. The solo half must add ZERO to acct-a's ranked
 * value_to_self and leave it below acct-b, surfacing only in the unranked
 * claimed-unattested figure. The counterfactual: under the old rule the $500k
 * folded into value_to_self ($530k), which would have ranked acct-a first.
 */
test("02 H2 SOLO CLAIM: a $500k solo claim adds zero ranked value and cannot outrank a co-attested deal", () => {
  const r = runProbe(
    "h2",
    `
    const A = await mkuser("acct-a"), B = await mkuser("acct-b");
    const pA = await mkuser("part-a"), pB = await mkuser("part-b");

    // acct-a: one genuinely co-attested $30k deal (its ranked value).
    const aCo = await deals.createDeal(A, "acct-a", { buyerToken: "v2:0", buyerIsOther: false, askId: null, totalUsd: 31000, myShareUsd: 30000, note: "", participants: [{ username: "part-a", shareUsd: 1000 }] });
    await deals.confirmDealShare(aCo.dealId, pA);
    // acct-a: a $500k SOLO claim (no named party).
    await deals.createDeal(A, "acct-a", { buyerToken: "v2:0", buyerIsOther: false, askId: null, totalUsd: 500000, myShareUsd: 500000, note: "", participants: [] });
    // acct-b: a co-attested $200k deal.
    const bCo = await deals.createDeal(B, "acct-b", { buyerToken: "v2:0", buyerIsOther: false, askId: null, totalUsd: 201000, myShareUsd: 200000, note: "", participants: [{ username: "part-b", shareUsd: 1000 }] });
    await deals.confirmDealShare(bCo.dealId, pB);

    const lb = await stats.computeLeaderboard();
    const rowA = lb.rows.find((x) => x.username === "acct-a");
    const rowB = lb.rows.find((x) => x.username === "acct-b");
    out.aValueToSelf = rowA.valueToSelfUsd;
    out.aClaimed = rowA.claimedUnattestedUsd;
    out.bValueToSelf = rowB.valueToSelfUsd;
    out.boardClaimed = lb.claimedUnattestedUsd;

    const pub = stats.toPublicLeaderboard(lb);
    out.rankA = pub.rows.find((x) => x.username === "acct-a").ranks.value_to_self;
    out.rankB = pub.rows.find((x) => x.username === "acct-b").ranks.value_to_self;

    // OLD behaviour: solo share folded into the ranked column.
    out.oldRankedA = rowA.valueToSelfUsd + rowA.claimedUnattestedUsd;
  `,
  );

  // The $500k solo adds nothing to the ranked column; it lives only in the claim figure.
  expect(r.aValueToSelf).toBe(30000);
  expect(r.aClaimed).toBe(500000);
  expect(r.boardClaimed).toBe(500000);

  // The co-attested $200k ranks above acct-a's ranked $30k. The solo did not move acct-a up.
  expect(r.bValueToSelf).toBe(200000);
  expect(r.rankB).toBe(1);
  expect(r.rankA).toBe(2);

  // Counterfactual: the old rule would have ranked acct-a first on $530k.
  expect(r.oldRankedA).toBe(530000);
  expect(
    r.oldRankedA as number,
    "old rule: the solo claim outranks a real co-attested deal",
  ).toBeGreaterThan(r.bValueToSelf as number);
});

/* ------------------------------------------------------- 3 H3 HOUSE FLOOR */

/**
 * No confirmed share is fee-free. A rootless earner (no invite edge) records a
 * confirmed $40,000 share; the 2.5% floor ($1,000) must accrue to the operator
 * (marble-pennant) as house rake, gate the earner once it ages past the grace
 * window, and surface in houseFloorReceivables. The counterfactual is the old
 * empty-chain short-circuit: ancestorChain is empty, on which the pre-fix
 * ledger charged nothing and settlementStanding returned behind:false forever.
 */
test("03 H3 HOUSE FLOOR: a rootless earner owes the operator the 2.5% floor; no confirmed share is fee-free", () => {
  const r = runProbe(
    "h3",
    `
    const MP = await mkuser("marble-pennant", true);
    const M  = await mkuser("member-1"); await edge(M, MP); // a normal member so MP is a graph root
    const E  = await mkuser("rootless-earner");             // NO invite edge
    const R  = await mkuser("h3-reporter");

    const d = await deals.createDeal(R, "h3-reporter", { buyerToken: "v2:0", buyerIsOther: false, askId: null, totalUsd: 60000, myShareUsd: 0, note: "", participants: [{ username: "rootless-earner", shareUsd: 40000 }] });
    await deals.confirmDealShare(d.dealId, E);

    // The old short-circuit condition: an empty human chain.
    out.humanChainLen = (await ref.ancestorChain(E)).length;
    // The fix: a synthetic depth-1 house node for the operator.
    out.eff = (await ref.effectiveAncestors(E)).map((a) => ({ u: a.username, depth: a.depth, isHouse: a.isHouse }));
    out.upline = (await ref.computeReferralLedger(E)).upline.map((a) => ({ u: a.username, depth: a.depth, accrued: a.accruedCents, isHouse: a.isHouse }));
    out.house = (await ref.houseFloorReceivables(MP)).map((x) => ({ u: x.username, accrued: x.accruedCents }));
    out.exactFloor = ref.accrualCents(40000, 1);

    // No confirmed share anywhere accrues zero total fee: sum the effective
    // ancestors' accrual for every earner in the graph.
    const earners = await db.execute({ sql: "SELECT DISTINCT user_id FROM deal_participants WHERE status='confirmed' AND share_usd>0" });
    const zeros = [];
    for (const row of earners.rows) {
      const uid = String(row.user_id);
      const anc = await ref.effectiveAncestors(uid);
      const share = Number((await db.execute({ sql: "SELECT SUM(share_usd) s FROM deal_participants WHERE user_id=? AND status='confirmed'", args: [uid] })).rows[0].s);
      const fee = anc.reduce((s, a) => s + ref.accrualCents(share, a.depth), 0);
      if (fee <= 0) zeros.push(uid);
    }
    out.feeFreeConfirmedShares = zeros.length;

    // Standing: dust-free within grace, gating once aged past it. Exact cents.
    out.standingFresh = (await ref.settlementStanding(E)).behind;
    await db.execute({ sql: "UPDATE deal_participants SET confirmed_at = confirmed_at - ? WHERE deal_id=? AND confirmed_at IS NOT NULL", args: [61 * DAY, d.dealId] });
    const st = await ref.settlementStanding(E);
    out.standingAged = st.behind ? st.pairs.map((p) => ({ u: p.payeeUsername, out: p.outstandingCents })) : false;
  `,
  );

  // Old short-circuit condition holds (empty human chain) but the floor now applies.
  expect(r.humanChainLen).toBe(0);
  expect(r.eff).toEqual([{ u: "marble-pennant", depth: 1, isHouse: true }]);

  // 2.5% of $40,000 = $1,000 = 100000 cents, accrued to the operator as house rake.
  expect(r.exactFloor).toBe(100000);
  expect(r.upline).toEqual([{ u: "marble-pennant", depth: 1, accrued: 100000, isHouse: true }]);
  expect(r.house).toEqual([{ u: "rootless-earner", accrued: 100000 }]);

  // Not one confirmed share in the graph escapes with zero total fee.
  expect(r.feeFreeConfirmedShares).toBe(0);

  // Counterfactual: the old empty-chain path returned behind:false regardless of age.
  // The fix gates the rootless earner on the aged $1,000 floor.
  expect(r.standingFresh).toBe(false);
  expect(r.standingAged).toEqual([{ u: "marble-pennant", out: 100000 }]);
});

/* --------------------------------------------- 4 H4 CONTACT CANONICALIZATION */

/**
 * Provider aliases of one inbox collapse to one blind index. nathan+tag@ and
 * n.athan@ on gmail are the same mailbox, so the second signup is refused as a
 * duplicate; a different gmail, a non-gmail dot-variant, and a non-gmail +tag
 * behave by the documented rules. The counterfactual: the old lowercase-only
 * rule produced two distinct indexes for the two aliases, minting a second
 * account from one inbox.
 */
test("04 H4 CANONICALIZATION: gmail aliases collapse to one contact; the second signup is refused", () => {
  const r = runProbe(
    "h4",
    `
    const P = "password-long-enough";
    async function mk(handle, raw) {
      const res = await auth.createUser(handle, P, "individual", crypto.normalizeContact(raw));
      return res.ok ? "ok" : res.error;
    }

    // Canonical forms (the pure transform).
    out.canon = {
      gPlus:      crypto.canonicalizeEmail("nathan+tag@gmail.com"),
      gDot:       crypto.canonicalizeEmail("n.athan@gmail.com"),
      googlemail: crypto.canonicalizeEmail("Nathan+xyz@GoogleMail.com"),
      gOther:     crypto.canonicalizeEmail("different@gmail.com"),
      fmPlus:     crypto.canonicalizeEmail("nathan+work@fastmail.com"),
      fmDot:      crypto.canonicalizeEmail("nat.han@fastmail.com"),
    };

    // Signups, in order. The alias of the first must be refused.
    out.r1 = await mk("u-aaa", "nathan+tag@gmail.com");    // claims nathan@gmail.com
    out.r2 = await mk("u-bbb", "n.athan@gmail.com");       // same inbox -> refused
    out.r3 = await mk("u-ccc", "Nathan+xyz@GoogleMail.com"); // googlemail folds -> refused
    out.r4 = await mk("u-ddd", "different@gmail.com");     // different inbox -> ok
    out.r5 = await mk("u-eee", "nathan@fastmail.com");     // claims nathan@fastmail.com
    out.r6 = await mk("u-fff", "nathan+work@fastmail.com"); // +tag stripped -> refused
    out.r7 = await mk("u-ggg", "nat.han@fastmail.com");    // non-gmail dots kept -> ok

    // OLD rule (lowercase only) vs NEW rule (canonicalized blind index).
    out.oldA = crypto.hmacHex("contact", "nathan+tag@gmail.com");
    out.oldB = crypto.hmacHex("contact", "n.athan@gmail.com");
    out.newA = crypto.contactBlindIndex("nathan+tag@gmail.com");
    out.newB = crypto.contactBlindIndex("n.athan@gmail.com");

    // What actually landed in users: handles and 64-hex indexes, no address.
    const rows = await db.execute({ sql: "SELECT username, contact_blind_index FROM users ORDER BY username" });
    out.stored = rows.rows.map((x) => ({ u: String(x.username), bi: String(x.contact_blind_index) }));
  `,
  );

  const canon = r.canon as Record<string, string>;
  expect(canon.gPlus).toBe("nathan@gmail.com");
  expect(canon.gDot).toBe("nathan@gmail.com");
  expect(canon.googlemail).toBe("nathan@gmail.com");
  expect(canon.gOther).toBe("different@gmail.com");
  expect(canon.fmPlus).toBe("nathan@fastmail.com");
  expect(canon.fmDot).toBe("nat.han@fastmail.com");

  // The duplicate is refused; the genuinely distinct addresses are admitted.
  expect(r.r1).toBe("ok");
  expect(r.r2, "n.athan@gmail.com is the same inbox as nathan+tag@gmail.com").toBe("contact_taken");
  expect(r.r3, "googlemail folds onto gmail").toBe("contact_taken");
  expect(r.r4).toBe("ok");
  expect(r.r5).toBe("ok");
  expect(r.r6, "a non-gmail +tag is still an alias of the base mailbox").toBe("contact_taken");
  expect(r.r7, "non-gmail dots are significant, so this is a new mailbox").toBe("ok");

  // Counterfactual: old lowercase-only produced two distinct indexes for one inbox;
  // the new canonicalization collapses them, so the UNIQUE constraint bites.
  expect(r.oldA).not.toBe(r.oldB);
  expect(r.newA).toBe(r.newB);

  // Four accounts survived (the three aliases were refused), each stored as a
  // bare HMAC index with no trace of the address.
  const stored = r.stored as { u: string; bi: string }[];
  expect(stored.map((s) => s.u)).toEqual(["u-aaa", "u-ddd", "u-eee", "u-ggg"]);
  for (const s of stored) {
    expect(s.bi).toMatch(/^[0-9a-f]{64}$/);
    expect(s.bi.includes("nathan") || s.bi.includes("gmail") || s.bi.includes("@")).toBe(false);
  }
});

/* ---------------------------------------------------- 5 H5 DISPUTE LIFECYCLE */

/**
 * A raised dispute lifts the posting gate, but only for a bounded window or
 * until an operator rules; it never disarms enforcement forever. Y is behind
 * on three ancestors; raising lifts all three; the X window then lapses and X
 * re-engages; the operator rejects QL (re-engages inside the window) and
 * upholds MP (stays lifted). The counterfactual: the dispute rows still EXIST
 * after the window lapses, which is all the pre-fix code checked, so it would
 * have reported behind:false forever. A live-server slice proves a non-operator
 * cannot reach the resolve/list routes, while an operator can.
 */
test("05 H5 DISPUTE LIFECYCLE: raise lifts for a bounded window; expiry and reject revert; uphold clears; admin API is operator-only", async () => {
  const r = runProbe(
    "h5",
    `
    const OP = await mkuser("h5-op", true);           // operator, outside Y's chain
    const MP = await mkuser("h5-mp");
    const QL = await mkuser("h5-ql");
    const X  = await mkuser("h5-x");
    const Y  = await mkuser("h5-y");
    const R  = await mkuser("h5-r");
    await edge(QL, MP); await edge(X, QL); await edge(Y, X); // Y: X(1) QL(2) MP(3)

    // Y confirms a $640k share on a deal already 61 days old, so all three
    // depths clear the $1 floor and the 60-day grace: X $16,000, QL $400, MP $10.
    const T0 = now() - 61 * DAY;
    const D = nid("dl");
    await db.execute({ sql: "INSERT INTO deals (id, reporter_id, buyer_token, total_usd, created_at) VALUES (?,?,?,?,?)", args: [D, R, "v2:0", 700000, T0] });
    await db.execute({ sql: "INSERT INTO deal_participants (deal_id, user_id, role, share_usd, status, confirmed_at) VALUES (?,?,'reporter',0,'confirmed',?)", args: [D, R, T0] });
    await db.execute({ sql: "INSERT INTO deal_participants (deal_id, user_id, role, share_usd, status, confirmed_at) VALUES (?,?,'participant',640000,'confirmed',?)", args: [D, Y, T0] });

    async function behind(u) { const s = await ref.settlementStanding(u); return s.behind ? s.pairs.map((p) => p.payeeUsername).sort() : false; }
    async function ageDispute(payer, payee, ms) { await db.execute({ sql: "UPDATE referral_disputes SET raised_at = raised_at - ? WHERE payer_id=? AND payee_id=?", args: [ms, payer, payee] }); }

    out.baseline = await behind(Y);
    await ref.raiseDispute(Y, "h5-x"); await ref.raiseDispute(Y, "h5-ql"); await ref.raiseDispute(Y, "h5-mp");
    out.afterRaise = await behind(Y);

    // THE GUARD: age the X dispute past the 45-day window. It reverts to gating.
    await ageDispute(Y, X, 46 * DAY);
    out.afterExpiry = await behind(Y);
    // Counterfactual: the row still exists, which is all the old code consulted.
    out.rowStillExists = Number((await db.execute({ sql: "SELECT COUNT(*) n FROM referral_disputes WHERE payer_id=? AND payee_id=?", args: [Y, X] })).rows[0].n);
    const agedRaised = Number((await db.execute({ sql: "SELECT raised_at FROM referral_disputes WHERE payer_id=? AND payee_id=?", args: [Y, X] })).rows[0].raised_at);
    out.liftsAged = ref.disputeLiftsGate("open", agedRaised, now());
    out.liftsFresh = ref.disputeLiftsGate("open", now(), now());

    // Operator rejects QL (re-engages inside its window) and upholds MP (stays lifted).
    out.reject = (await ref.resolveDispute(OP, ref.disputeId(Y, QL), "reject")).status;
    out.afterReject = await behind(Y);
    out.uphold = (await ref.resolveDispute(OP, ref.disputeId(Y, MP), "uphold")).status;
    out.afterUphold = await behind(Y);

    // A resolved/existing pair cannot buy a fresh window, and only operators rule.
    out.reRaise = (await ref.raiseDispute(Y, "h5-x")).error;
    out.doubleResolve = (await ref.resolveDispute(OP, ref.disputeId(Y, QL), "reject")).error;
    out.nonOperator = (await ref.resolveDispute(Y, ref.disputeId(Y, MP), "uphold")).error;
    out.badRuling = (await ref.resolveDispute(OP, ref.disputeId(Y, X), "maybe")).error;
  `,
  );

  expect(r.baseline).toEqual(["h5-mp", "h5-ql", "h5-x"]);
  expect(r.afterRaise, "a fresh dispute on every pair lifts the gate").toBe(false);

  // Window expiry re-engages X. The counterfactual proves it is not row-existence
  // that lifts: the row is still there (1), yet the debt gates again.
  expect(r.afterExpiry).toEqual(["h5-x"]);
  expect(r.rowStillExists).toBe(1);
  expect(r.liftsAged).toBe(false);
  expect(r.liftsFresh).toBe(true);

  // Reject re-engages QL inside its window; uphold keeps MP lifted.
  expect(r.reject).toBe("rejected");
  expect(r.afterReject).toEqual(["h5-ql", "h5-x"]);
  expect(r.uphold).toBe("upheld");
  expect(r.afterUphold).toEqual(["h5-ql", "h5-x"]);

  // The surrounding guards.
  expect(r.reRaise).toBe("already_disputed");
  expect(r.doubleResolve).toBe("already_resolved");
  expect(r.nonOperator).toBe("not_operator");
  expect(r.badRuling).toBe("bad_ruling");

  // Live server: the admin dispute API is operator-only. Read-only; mutates nothing.
  // Signed out, the dot-free list path is bounced to /gate by the gate middleware;
  // the resolve path carries a dotted id (payer.payee), which the middleware matcher
  // skips, so the route's own getSessionUser check answers 401. Either way it is
  // never served.
  const anon = await pwRequest.newContext({ baseURL: BASE });
  const anonList = await anon.get("/api/admin/disputes", { maxRedirects: 0 });
  expect([302, 307], "signed out is redirected, not served").toContain(anonList.status());
  expect(anonList.headers()["location"] ?? "").toContain("/gate");
  const anonResolve = await anon.post("/api/admin/disputes/x.y/resolve", {
    data: { ruling: "reject" },
  });
  expect(anonResolve.status(), "signed out cannot resolve").toBe(401);
  await anon.dispose();

  const member = await pwRequest.newContext({ baseURL: BASE });
  const memberLogin = await member.post("/api/auth/login", {
    data: { username: "granite-fox", password: DEMO_PASSWORD },
  });
  expect(memberLogin.status()).toBe(200);
  expect((await member.get("/api/admin/disputes")).status(), "a non-operator cannot list").toBe(403);
  const memberResolve = await member.post("/api/admin/disputes/x.y/resolve", {
    data: { ruling: "reject" },
  });
  expect(memberResolve.status(), "a non-operator cannot resolve").toBe(403);
  await member.dispose();

  // Positive control: the same route answers 200 for a real operator, so the 403
  // is the operator gate and not a blanket refusal.
  const op = await pwRequest.newContext({ baseURL: BASE });
  const opLogin = await op.post("/api/auth/login", {
    data: { username: "quiet-ledger", password: DEMO_PASSWORD },
  });
  expect(opLogin.status()).toBe(200);
  const opList = await op.get("/api/admin/disputes");
  expect(opList.status(), "an operator may list disputes").toBe(200);
  expect((await opList.json()).disputes, "the list route returns a disputes array").toBeDefined();
  await op.dispose();
});

/* --------------------------------------------------------------- 6 PRIVACY */

/**
 * The affected and new tables hold tokens and integers, never PII, and
 * canonicalization stores only the blind index. The scanner is proven
 * sensitive against a synthetic address first, then run over the live app.db;
 * the users table is shown to carry exactly the six schema columns (no email,
 * phone, name or org column), with every contact index a bare 64-hex HMAC.
 */
test("06 PRIVACY: the referral/dispute/invite/user tables hold no PII; contacts are stored only as blind indexes", async () => {
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const TABLES = [
    "users",
    "invites",
    "invite_edges",
    "referral_settlements",
    "referral_disputes",
    "referral_dispute_status",
  ];

  /** Flag any cell that looks like an email, a seeded phone, or an example address. */
  function offendingCells(rows: { table: string; col: string; value: string }[]): string[] {
    const bad: string[] = [];
    for (const { table, col, value } of rows) {
      if (EMAIL_RE.test(value) || value.includes("@example.com") || value.includes("415 555")) {
        bad.push(`${table}.${col}=${value}`);
      }
    }
    return bad;
  }

  // Sensitivity: a planted address MUST be caught, or the scan below proves nothing.
  const planted = offendingCells([
    { table: "referral_settlements", col: "note", value: "paid to sentinel-pii@example.com" },
  ]);
  expect(planted, "the scanner catches a planted address").toEqual([
    "referral_settlements.note=paid to sentinel-pii@example.com",
  ]);

  await withDb(async (db) => {
    // The real scan over the live tables: nothing.
    const cells: { table: string; col: string; value: string }[] = [];
    for (const table of TABLES) {
      const rs = await db.execute(`SELECT * FROM ${table}`);
      for (const row of rs.rows) {
        for (const col of rs.columns) {
          cells.push({ table, col, value: String(row[col] ?? "") });
        }
      }
    }
    expect(offendingCells(cells)).toEqual([]);

    // The users table is exactly the six schema columns: no address, phone,
    // real-name or org column exists to hold PII in the first place.
    const cols = (await db.execute(`PRAGMA table_info(users)`)).rows
      .map((r) => String(r.name))
      .sort();
    expect(cols).toEqual(
      ["account_type", "contact_blind_index", "created_at", "id", "password_hash", "username"].sort(),
    );

    // Every stored contact is a bare 64-hex HMAC, never an address.
    const users = await db.execute(`SELECT contact_blind_index AS bi FROM users`);
    expect(users.rows.length).toBeGreaterThan(0);
    for (const u of users.rows) {
      expect(String(u.bi)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
