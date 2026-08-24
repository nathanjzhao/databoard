/**
 * tests/trust.spec.ts
 *
 * The three mechanism guarantees, proven in a real browser:
 *
 *   (1) E2EE: message text exists only as ciphertext outside the two
 *       browsers that hold the thread key; no private key material in the
 *       database or any API response.
 *   (2) The password-derived identity key survives logout/login.
 *   (3) VOPRF buyer tokens: the buyer name never appears in any network
 *       request; equal names collide into equal v2 tokens across users and
 *       processes; the database holds no lab name anywhere.
 *   (4) DLEQ: a tampered evaluation is rejected client-side, loudly, and
 *       nothing is submitted.
 *   (5) The seeded pre-E2EE thread stays honest: plaintext, labeled.
 *   (6) The commit stamp and the /transparency page carry the new claims
 *       without losing the old ones.
 *
 * PRECONDITION: same as flow.spec.ts. Fresh reset + seed, dev server
 * started after the reset. Serial; one worker.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { promises as fs } from "node:fs";
import path from "node:path";
import { KNOWN_BUYERS } from "../lib/buyers";
import { deriveIdentityKeys, toB64url } from "../lib/e2ee";

const ROOT = path.resolve(__dirname, "..");
const VERIFY_DIR = path.join(ROOT, "verify", "trust");
const DB_PATH = path.join(ROOT, "data", "app.db");

/* ------------------------------------------------------------- test data */

const USER_F = {
  realName: "Fiona Merced",
  org: "Larkspur Robotics",
  contact: "4155559301",
  username: "verifier-fern",
  password: "fern-verifies-crypto",
};

const USER_G = {
  realName: "Gopal Rao",
  contact: "gale.rao.test@example.net",
  username: "verifier-gale",
  password: "gale-verifies-crypto",
};

const SECRET_MESSAGE = "the eagle flies at midnight";
const SECRET_REPLY = "Copy that. The courier confirms by Friday.";

const ASK_F = {
  title: "Warehouse forklift teleop logs with fault annotations",
  category: "Expert demonstrations",
  buyer: "Anthropic",
  pct: 20,
  description:
    "Operator logs from certified drivers, annotated near-miss and fault events, per-shift session boundaries.",
};

const ASK_G = {
  title: "Bimanual assembly demonstrations with force-torque traces",
  category: "Eval / benchmark data",
  buyer: "Anthropic",
  pct: 10,
  description:
    "Two-arm assembly runs with synchronized wrist force-torque streams and success grades per attempt.",
};

const ASK_TAMPERED = {
  title: "Cold-chain sensor streams from refrigerated freight",
  category: "Domain corpus",
  buyer: "Anthropic",
  pct: 0,
  description: "Never submitted: the evaluation under this ask is tampered mid-flight.",
};

const COLLAB_NOTE =
  "Holding graded assembly runs from an adjacent task family. Overlap looks real.";

/* ------------------------------------------------------- shared run state */

let context: BrowserContext;
let page: Page;
let askFUrl = "";
let threadId = "";

/** Every non-static request the context ever made: URL plus POST body. */
const wireRequests: { url: string; body: string }[] = [];
/** Body text of every /api/ response the context ever received. */
const apiResponses: { url: string; text: Promise<string> }[] = [];

function isStaticAsset(url: string): boolean {
  return (
    url.includes("/_next/") ||
    /\.(png|jpg|svg|ico|woff2?|ttf|css|map)(\?|$)/.test(url)
  );
}

async function shot(p: Page, name: string) {
  await p.screenshot({ path: path.join(VERIFY_DIR, name), fullPage: true });
}

/* ------------------------------------------------------------ UI helpers */

async function signUp(
  p: Page,
  opts: {
    realName: string;
    org?: string;
    contact: string;
    username: string;
    password: string;
  },
) {
  await p.goto("/signup");
  await expect(p.getByText("Say who you are, once")).toBeVisible();

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
  const codeInput = p.getByLabel("Six digit code");
  await codeInput.fill("");
  await codeInput.fill(demoCode);
  await p.getByRole("button", { name: "Continue" }).click();

  await expect(p.getByText("Pick what we actually keep")).toBeVisible();
  await p.getByLabel("Username").fill(opts.username);
  await p.getByLabel("Password").fill(opts.password);
  await p.getByRole("button", { name: "Create account" }).click();
  await expect(p.getByText(`@${opts.username}`).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function signOut(p: Page) {
  await p.getByRole("button", { name: "Sign out" }).click();
  await p.waitForURL(/\/gate$/);
}

async function logIn(p: Page, username: string, password: string) {
  await p.goto("/login");
  await p.getByLabel("Username").fill(username);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname === "/");
  // The login form fires router.refresh() and router.push together; when
  // push wins the race the board comes from the logged-out router cache.
  // One reload renders server-side with the session cookie that is already
  // set, which is the claim that matters here.
  const handle = p.getByText(`@${username}`).first();
  try {
    await expect(handle).toBeVisible({ timeout: 3000 });
  } catch {
    await p.reload();
    await expect(handle).toBeVisible();
  }
}

async function setSlider(p: Page, label: string, value: number) {
  await p.getByLabel(label).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function postAsk(p: Page, ask: typeof ASK_F): Promise<string> {
  await p.goto("/new");
  await p.getByLabel("Title").fill(ask.title);
  await p.getByLabel("Category").selectOption({ label: ask.category });
  await p.getByLabel("Description").fill(ask.description);
  if (ask.pct > 0) await setSlider(p, "Percent of supply already filled", ask.pct);
  await p.getByLabel("Buying lab").selectOption(ask.buyer);
  await p.getByRole("button", { name: "Post to the board" }).click();
  await p.waitForURL(/\/ask\/[^/]+$/);
  await expect(p.getByRole("heading", { name: ask.title })).toBeVisible();
  return p.url();
}

async function boardChip(p: Page, title: string): Promise<string> {
  const row = p.locator("li").filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  const chips = await row.getByText(/^#[0-9a-f]{4}$/).allTextContents();
  expect(chips.length).toBeGreaterThan(0);
  expect(new Set(chips).size).toBe(1);
  return chips[0];
}

/* ------------------------------------------------------------ DB helpers */

type DbDump = {
  tables: string[];
  values: { table: string; col: string; value: string }[];
};

async function dumpDb(): Promise<DbDump> {
  const client = createClient({ url: `file:${DB_PATH}` });
  const tablesRs = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const tables = tablesRs.rows.map((r) => String(r.name));
  const values: DbDump["values"] = [];
  for (const table of tables) {
    const rs = await client.execute(`SELECT * FROM "${table}"`);
    for (const row of rs.rows) {
      for (const col of rs.columns) {
        const raw = (row as Record<string, unknown>)[col];
        if (raw == null) continue;
        values.push({ table, col, value: String(raw) });
      }
    }
  }
  client.close();
  return { tables, values };
}

/** Case-insensitive scan; returns "table.col" hits containing the pattern. */
function scanDump(dump: DbDump, pattern: string): string[] {
  const p = pattern.toLowerCase();
  return dump.values
    .filter((v) => v.value.toLowerCase().includes(p))
    .map((v) => `${v.table}.${v.col}: ${v.value.slice(0, 80)}`);
}

async function rawDbBytes(): Promise<string> {
  let all = "";
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      all += (await fs.readFile(DB_PATH + suffix)).toString("latin1");
    } catch {
      // sidecar not present
    }
  }
  return all;
}

async function askCountByTitle(title: string): Promise<number> {
  const client = createClient({ url: `file:${DB_PATH}` });
  const rs = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM asks WHERE title = ?`,
    args: [title],
  });
  client.close();
  return Number(rs.rows[0].n);
}

/* --------------------------------------------------------------- fixture */

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await fs.mkdir(VERIFY_DIR, { recursive: true });
  context = await browser.newContext();
  context.on("request", (req) => {
    wireRequests.push({ url: req.url(), body: req.postData() ?? "" });
  });
  context.on("response", (res) => {
    const url = res.url();
    if (isStaticAsset(url) || !url.includes("/api/")) return;
    apiResponses.push({ url, text: res.text().catch(() => "") });
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

/* ----------------------------------------------------------- (1) E2EE */

test("1a F and G sign up; each registers exactly the pubkey their password derives", async () => {
  await signUp(page, USER_F);
  await signOut(page);
  await signUp(page, USER_G);
  await shot(page, "01a-signups-done.png");

  // The write-once server-side key must be the client-side derivation,
  // reproduced here in node from username + password alone.
  const fKeys = await deriveIdentityKeys(USER_F.username, USER_F.password);
  const gKeys = await deriveIdentityKeys(USER_G.username, USER_G.password);
  const client = createClient({ url: `file:${DB_PATH}` });
  const rs = await client.execute(
    `SELECT u.username, k.pubkey FROM user_e2ee_keys k JOIN users u ON u.id = k.user_id
      WHERE u.username IN ('${USER_F.username}', '${USER_G.username}')`,
  );
  client.close();
  const byUser = new Map(rs.rows.map((r) => [String(r.username), String(r.pubkey)]));
  expect(byUser.get(USER_F.username)).toBe(fKeys.publicKey);
  expect(byUser.get(USER_G.username)).toBe(gKeys.publicKey);
});

test("1b F posts the Anthropic ask; G requests collab on it", async () => {
  // G is signed in. F's ask goes up first, so switch, post, switch back.
  await signOut(page);
  await logIn(page, USER_F.username, USER_F.password);
  askFUrl = await postAsk(page, ASK_F);
  await signOut(page);
  await logIn(page, USER_G.username, USER_G.password);

  await page.goto(askFUrl);
  await page.getByLabel("Note to the poster, optional").fill(COLLAB_NOTE);
  await page.getByRole("button", { name: "Request to collaborate" }).click();
  await expect(page.getByText("Request sent", { exact: true })).toBeVisible();
  await shot(page, "01b-collab-requested.png");
});

test("1c F accepts; the thread comes up end-to-end encrypted; F sends the secret", async () => {
  await signOut(page);
  await logIn(page, USER_F.username, USER_F.password);

  await page.goto("/matches");
  await expect(page.getByText("Needs a decision")).toBeVisible();
  await page.getByRole("button", { name: "Accept and open a thread" }).click();
  await page.waitForURL(/\/messages\/[^/]+$/);
  threadId = page.url().split("/messages/")[1];
  expect(threadId.length).toBeGreaterThan(0);

  // The first client to open the thread installs the keys; the tag flips
  // to encrypted before anything can be sent.
  await expect(page.getByText("end-to-end encrypted", { exact: true })).toBeVisible();

  await page
    .getByPlaceholder("Plain text. Enter sends, Shift+Enter for a new line.")
    .fill(SECRET_MESSAGE);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("ol")).toContainText(SECRET_MESSAGE);
  await shot(page, "01c-f-sent-secret.png");
});

test("1d G reads the secret decrypted in the UI and replies", async () => {
  await signOut(page);
  await logIn(page, USER_G.username, USER_G.password);

  await page.goto(`/messages/${threadId}`);
  await expect(page.getByText("end-to-end encrypted", { exact: true })).toBeVisible();
  await expect(page.locator("ol")).toContainText(SECRET_MESSAGE);

  const composer = page.getByPlaceholder(
    "Plain text. Enter sends, Shift+Enter for a new line.",
  );
  await composer.fill(SECRET_REPLY);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("ol")).toContainText(SECRET_REPLY);
  await shot(page, "01d-g-reads-decrypted.png");
});

test("1e THE E2EE CLAIM: ciphertext only in the DB; no private key material anywhere", async () => {
  const dump = await dumpDb();

  // The message text is nowhere: not in any row of any table...
  expect(scanDump(dump, SECRET_MESSAGE)).toEqual([]);
  expect(scanDump(dump, SECRET_REPLY)).toEqual([]);
  // ...and not in any free page or WAL frame of the raw files either.
  const raw = (await rawDbBytes()).toLowerCase();
  expect(raw.includes(SECRET_MESSAGE.toLowerCase())).toBe(false);
  expect(raw.includes(SECRET_REPLY.toLowerCase())).toBe(false);

  // What IS stored for this thread is strictly envelope-shaped ciphertext.
  const client = createClient({ url: `file:${DB_PATH}` });
  const msgs = await client.execute({
    sql: `SELECT body FROM messages WHERE thread_id = ?`,
    args: [threadId],
  });
  const keys = await client.execute({
    sql: `SELECT wrapped_key, eph_pubkey FROM thread_keys WHERE thread_id = ?`,
    args: [threadId],
  });
  client.close();
  // Three rows: the collab note (plaintext BY DESIGN and said so on
  // /transparency: both sides already read it on the request card) plus the
  // two messages typed in the encrypted thread, stored as envelopes only.
  const bodies3 = msgs.rows.map((m) => String(m.body));
  expect(bodies3.length).toBe(3);
  expect(bodies3.filter((b) => b === COLLAB_NOTE).length).toBe(1);
  const envelopes = bodies3.filter((b) => /^e2ee-v1-[A-Za-z0-9_-]{39,}$/.test(b));
  expect(envelopes.length).toBe(2);
  expect(keys.rows.length).toBe(2); // one wrap per seat, no more

  // No private key material: the exact secrets both accounts derive, in
  // both encodings, appear neither in the DB nor in any API response body.
  const fKeys = await deriveIdentityKeys(USER_F.username, USER_F.password);
  const gKeys = await deriveIdentityKeys(USER_G.username, USER_G.password);
  const secrets = [
    toB64url(fKeys.secretKey),
    toB64url(gKeys.secretKey),
    Buffer.from(fKeys.secretKey).toString("hex"),
    Buffer.from(gKeys.secretKey).toString("hex"),
  ];
  for (const s of secrets) {
    expect(scanDump(dump, s)).toEqual([]);
    expect(raw.includes(s.toLowerCase())).toBe(false);
  }

  const bodies = await Promise.all(apiResponses.map((r) => r.text));
  expect(bodies.length).toBeGreaterThan(10); // the capture actually captured
  for (let i = 0; i < bodies.length; i++) {
    for (const s of secrets) {
      expect(
        bodies[i].includes(s),
        `API response ${apiResponses[i].url} contains private key material`,
      ).toBe(false);
    }
    expect(
      bodies[i].toLowerCase().includes(SECRET_MESSAGE.toLowerCase()),
      `API response ${apiResponses[i].url} contains the plaintext message`,
    ).toBe(false);
  }

  // And the plaintext never left the browser in a request either.
  for (const r of wireRequests) {
    expect(
      r.body.toLowerCase().includes(SECRET_MESSAGE.toLowerCase()),
      `request to ${r.url} carried the plaintext`,
    ).toBe(false);
  }
});

/* -------------------------------------------------- (2) key stability */

test("2 F logs out and back in and can still read the thread", async () => {
  await signOut(page);
  await logIn(page, USER_F.username, USER_F.password);
  await page.goto(`/messages/${threadId}`);
  await expect(page.getByText("end-to-end encrypted", { exact: true })).toBeVisible();
  await expect(page.locator("ol")).toContainText(SECRET_MESSAGE);
  await expect(page.locator("ol")).toContainText(SECRET_REPLY);
  await shot(page, "02-f-relogin-still-decrypts.png");
});

/* ------------------------------------------------------------ (3) VOPRF */

test("3a G posts the second Anthropic ask; chips collide; /matches groups them", async () => {
  await signOut(page);
  await logIn(page, USER_G.username, USER_G.password);
  await postAsk(page, ASK_G);
  await shot(page, "03a-g-ask-posted.png");

  await page.goto("/");
  const chipF = await boardChip(page, ASK_F.title);
  const chipG = await boardChip(page, ASK_G.title);
  expect(chipF).toMatch(/^#[0-9a-f]{4}$/);
  expect(chipF).toBe(chipG);
  // Cross-process too: the seed minted its Anthropic token server-side in a
  // separate node process; the browser-blinded mints must collide with it.
  const chipSeed = await boardChip(
    page,
    "Contested-topic preference pairs, expert-rated",
  );
  expect(chipSeed).toBe(chipF);
  await shot(page, "03b-board-same-chip.png");

  await page.goto("/matches");
  await expect(page.getByText("Buyer overlap")).toBeVisible();
  await expect(page.getByText(ASK_F.title)).toBeVisible();
  await shot(page, "03c-matches-grouped.png");
});

test("3b THE VOPRF CLAIM: the name never crossed the wire; the DB holds only v2 tokens", async () => {
  // Every request this context ever sent, page loads and API calls alike:
  // no URL and no body ever contained the buyer's name. (Static assets are
  // excluded from body capture by construction; their URLs are still
  // scanned here.)
  expect(wireRequests.length).toBeGreaterThan(50); // the capture is real
  for (const r of wireRequests) {
    const hay = (r.url + "\n" + r.body).toLowerCase();
    expect(hay.includes("anthropic"), `request leaked the name: ${r.url}`).toBe(false);
  }

  // Positive control: the blinded protocol did run, exactly as designed.
  const evals = wireRequests.filter((r) => r.url.includes("/api/voprf/evaluate"));
  expect(evals.length).toBeGreaterThanOrEqual(2); // one per posted ask
  for (const e of evals) {
    expect(e.body).toMatch(/"evalReq"\s*:\s*"[0-9a-f]+"/);
  }
  const askPosts = wireRequests.filter(
    (r) => r.url.includes("/api/asks") && r.body.length > 0,
  );
  expect(askPosts.length).toBeGreaterThanOrEqual(2);
  for (const a of askPosts) {
    expect(a.body).toContain('"buyerTokenV2":"v2:');
    expect(a.body.toLowerCase()).not.toContain("buyername");
  }

  // The database: no lab name in any row of any table (same opaque-value
  // carve-out as the flow spec: random base64url ids can contain any short
  // letter run by coin flip), and every stored token is a v2 token.
  const dump = await dumpDb();
  const OPAQUE = /^[A-Za-z0-9_-]{16,}$/;
  const patterns = [
    ...KNOWN_BUYERS,
    ...KNOWN_BUYERS.map((b) => b.toLowerCase().replace(/[^a-z0-9]+/g, "")),
  ].map((s) => s.toLowerCase());
  const violations: string[] = [];
  for (const v of dump.values) {
    const lower = v.value.toLowerCase();
    const opaque = OPAQUE.test(v.value);
    for (const pat of new Set(patterns)) {
      if (opaque && pat.length < 6) continue;
      if (lower.includes(pat)) {
        violations.push(`${v.table}.${v.col} contains "${pat}"`);
      }
    }
  }
  expect(violations, "lab name found in the database").toEqual([]);

  const client = createClient({ url: `file:${DB_PATH}` });
  const tokens = await client.execute(
    `SELECT buyer_token FROM asks UNION ALL SELECT buyer_token FROM deals`,
  );
  client.close();
  expect(tokens.rows.length).toBeGreaterThanOrEqual(17); // 10+5 seeded, 2 here
  for (const t of tokens.rows) {
    expect(String(t.buyer_token)).toMatch(/^v2:[0-9a-f]{128}$/);
  }
});

/* ------------------------------------------------------------- (4) DLEQ */

test("4 a tampered evaluation fails the DLEQ check: visible refusal, nothing submitted", async () => {
  // G is signed in. Tamper the server's reply in flight: flip the last hex
  // character of the serialized evaluation (a proof byte), leaving a
  // well-formed reply signed by, in effect, a different key.
  await page.route("**/api/voprf/evaluate", async (route) => {
    const res = await route.fetch();
    const data = (await res.json()) as { evaluation?: string };
    if (typeof data.evaluation === "string" && data.evaluation.length > 0) {
      const last = data.evaluation.slice(-1);
      data.evaluation =
        data.evaluation.slice(0, -1) + (last === "0" ? "1" : "0");
    }
    await route.fulfill({
      status: res.status(),
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });

  await page.goto("/new");
  await page.getByLabel("Title").fill(ASK_TAMPERED.title);
  await page.getByLabel("Category").selectOption({ label: ASK_TAMPERED.category });
  await page.getByLabel("Description").fill(ASK_TAMPERED.description);
  await page.getByLabel("Buying lab").selectOption(ASK_TAMPERED.buyer);
  await page.getByRole("button", { name: "Post to the board" }).click();

  // The client refuses: visible error naming the proof, no navigation.
  await expect(
    page.getByText(/failed its consistency proof/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/new$/);
  await shot(page, "04-dleq-tampered-rejected.png");

  await page.unroute("**/api/voprf/evaluate");

  // Nothing reached the database.
  expect(await askCountByTitle(ASK_TAMPERED.title)).toBe(0);

  // Control for the control: the same form, untampered, goes straight
  // through, so the refusal above was the DLEQ check and not a broken form.
  await page.getByRole("button", { name: "Post to the board" }).click();
  await page.waitForURL(/\/ask\/[^/]+$/);
  expect(await askCountByTitle(ASK_TAMPERED.title)).toBe(1);
});

/* ----------------------------------------------------------- (5) legacy */

test("5 the seeded pre-E2EE thread is plaintext and wears its tag", async () => {
  await signOut(page);
  await logIn(page, "quiet-ledger", "demo-demo-demo");

  await page.goto("/messages");
  await page
    .locator('a[href^="/messages/"]')
    .filter({ hasText: "attic-lantern" })
    .first()
    .click();
  await page.waitForURL(/\/messages\/[^/]+$/);

  await expect(
    page.getByText("not end-to-end encrypted", { exact: true }),
  ).toBeVisible();
  // The legacy text renders as stored: plaintext, readable, labeled.
  await expect(page.locator("ol")).toContainText(
    "License chains are documented for both archives",
  );
  await shot(page, "05-legacy-plaintext-tag.png");

  // Contrast: the seeded ENCRYPTED deal room decrypts for the same login,
  // proving the seed's server-side sealing round-trips with the browser.
  await page.goto("/messages");
  await page
    .locator('a[href^="/messages/"]')
    .filter({ hasText: "Deal room" })
    .filter({ hasText: "granite-fox" })
    .first()
    .click();
  await page.waitForURL(/\/messages\/[^/]+$/);
  await expect(page.getByText("end-to-end encrypted", { exact: true })).toBeVisible();
  await expect(page.locator("ol")).toContainText("Recorded the split as agreed");
  await shot(page, "05b-seeded-encrypted-room-decrypts.png");
});

/* --------------------------------------------- (6) stamp + transparency */

test("6 commit stamp links to the repo; /transparency carries new and old claims", async ({
  request,
}) => {
  // The footer stamp, on a public page, no login needed.
  await page.goto("/transparency");
  const stamp = page.locator('a[title="The commit this deployment was built from"]');
  await expect(stamp).toBeVisible();
  await expect(stamp).toHaveText(/running ([0-9a-f]{7}|dev)/);
  expect(await stamp.getAttribute("href")).toMatch(
    /^https:\/\/github\.com\/nathanjzhao\/databoard/,
  );

  // New: the OPRF public key, printed on the page and equal to the one the
  // API serves (the key every client verifies DLEQ proofs against).
  const pk = (await (await request.get("/api/voprf/pubkey")).json()) as {
    publicKey: string;
    suite: string;
  };
  expect(pk.suite).toBe("ristretto255-SHA512");
  expect(pk.publicKey).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.locator("body")).toContainText(pk.publicKey);

  // New: the three-layer verify section.
  await expect(
    page.getByRole("heading", { name: "Verify it yourself, in three layers" }),
  ).toBeVisible();
  await expect(page.getByText("Checkable now, by anyone.")).toBeVisible();
  await expect(page.getByText("Still taken on our word.")).toBeVisible();
  await expect(page.getByText("Shrinking the gap.")).toBeVisible();

  // Pre-existing content, still standing: the verbatim schema block...
  await expect(page.locator("body")).toContainText("CREATE TABLE IF NOT EXISTS users");
  await expect(page.locator("body")).toContainText("contact_blind_index");
  // ...the can/cannot-see table...
  await expect(
    page.getByRole("heading", { name: "What we can see, what we cannot" }),
  ).toBeVisible();
  await expect(page.getByText("We can see").first()).toBeVisible();
  await expect(page.getByText("We cannot see").first()).toBeVisible();
  // ...and the stateless-attestation explanation.
  await expect(
    page.getByRole("heading", { name: "Verification without a verification table" }),
  ).toBeVisible();
  await expect(
    page.getByText("The server recomputes the HMAC and compares."),
  ).toBeVisible();

  await shot(page, "06-transparency-and-stamp.png");
});
