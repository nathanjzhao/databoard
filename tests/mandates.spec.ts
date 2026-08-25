/**
 * tests/mandates.spec.ts
 *
 * Proof suite for Tier A mandate commitments: an ask pinned to one document
 * by a SHA-256 committed from the poster's browser.
 *
 * PRECONDITION: same as flow.spec.ts. Fresh `npm run reset-db && npm run
 * seed`, dev server started after the reset. Runs after deals/flow/hardening
 * in file order; it adds one ask of its own (posted through the real form)
 * and touches nothing else, so responsive/trust stay green behind it.
 *
 * What is proved here:
 *   - the compose form pins a mandate: file hashed in the browser, only the
 *     hash and label sent, the ask page shows "committed with the post"
 *   - the board row wears the grayscale "mandate" mark
 *   - the owner's add-later panel commits against a seeded ask, and the
 *     honesty line shows the late commit next to the older posting date
 *   - the write-once guard fails on purpose: a second commit is 409 and the
 *     stored hash does not move
 *   - a non-owner is 403, a malformed hash is 400
 *   - a non-owner sees the committed record but no commit controls
 *   - the word "verified" appears nowhere on a mandate surface
 *   - the database holds the fingerprint, never the document bytes
 *   - the document-bytes scan is proven sensitive: a sentinel row planted
 *     into ask_mandates IS flagged, then removed
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");

const OWNER = { username: "vellum", password: "demo-demo-demo" };
const STRANGER = { username: "paper-trail", password: "demo-demo-demo" };

/** vellum's seeded ask, posted 4 days ago with no mandate. */
const SEEDED_TITLE = "Expert speedrun demonstrations of legacy Windows games";

const NEW_ASK_TITLE = "Continuous glucose trace batches with meal annotations";

/** The mandate "document": bytes that exist only in this test. */
const DOC_AT_POST = Buffer.from(
  "mandate-spec document: RFP for glucose trace batches, revision 2\n",
);
const DOC_LATE = Buffer.from(
  "mandate-spec document: buyer email thread, speedrun demonstrations\n",
);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let context: BrowserContext;
let page: Page;
let newAskUrl = "";
let seededAskUrl = "";

async function signIn(p: Page, who: { username: string; password: string }) {
  await p.goto("/login");
  await p.getByLabel("Handle").fill(who.username);
  await p.getByLabel("Password").fill(who.password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((url) => url.pathname === "/" || url.pathname === "", {
    timeout: 15_000,
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await signIn(page, OWNER);
});

test.afterAll(async () => {
  await context?.close();
});

test("01 compose form pins a mandate; ask page says committed with the post", async () => {
  await page.goto("/new");
  await page.getByLabel("Title").fill(NEW_ASK_TITLE);
  await page.getByLabel("Category").selectOption({ label: "Other" });
  await page.getByLabel("Buying lab").selectOption("Anthropic");
  await page.getByText("Non-exclusive", { exact: true }).click();

  // Pick the mandate document. The bytes stay in the browser; the receipt
  // and the POST body carry only the hash.
  await page.getByLabel("Mandate document").setInputFiles({
    name: "rfp-rev2.txt",
    mimeType: "text/plain",
    buffer: DOC_AT_POST,
  });
  const hex = sha256(DOC_AT_POST);
  await expect(page.getByText(`SHA-256 of rfp-rev2.txt`)).toBeVisible();
  await expect(page.getByText(hex)).toBeVisible();

  // The guard against silent drops: hashed but unlabeled blocks the post.
  await expect(page.getByText("An unlabeled pin does not post.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Post to the board" }),
  ).toBeDisabled();

  await page.getByLabel("Label").fill("Buyer RFP, rev 2");
  await expect(
    page.getByRole("button", { name: "Post to the board" }),
  ).toBeEnabled();

  // The receipt shows the mandate row the database will keep.
  await expect(page.getByText("ask_mandates.doc_hash")).toBeVisible();

  await page.getByRole("button", { name: "Post to the board" }).click();
  await page.waitForURL(/\/ask\/[^/]+$/);
  newAskUrl = page.url();

  await expect(page.getByText("Mandate committed")).toBeVisible();
  await expect(page.getByText(`${hex.slice(0, 12)}…`)).toBeVisible();
  await expect(page.getByText("Buyer RFP, rev 2")).toBeVisible();
  await expect(page.getByText(/committed with the post, just now/)).toBeVisible();

  // Truncated by default, full on click, full in the title attribute.
  const hashButton = page.locator(`button[title="${hex}"]`);
  await hashButton.click();
  await expect(page.getByText(hex)).toBeVisible();
});

test("02 board row wears the grayscale mandate mark", async () => {
  await page.goto("/");
  const row = page.locator("li").filter({ hasText: NEW_ASK_TITLE }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText("mandate", { exact: true })).toBeVisible();

  // A row without a mandate carries no mark.
  const bare = page
    .locator("li")
    .filter({ hasText: "Factory-floor multicam video" })
    .first();
  await expect(bare).toBeVisible();
  await expect(bare.getByText("mandate", { exact: true })).toHaveCount(0);
});

test("03 add-later panel commits against a seeded ask, visibly late", async () => {
  await page.goto("/");
  const href = await page
    .locator("li")
    .filter({ hasText: SEEDED_TITLE })
    .first()
    .locator("a")
    .first()
    .getAttribute("href");
  expect(href).toBeTruthy();
  seededAskUrl = href!;

  await page.goto(seededAskUrl);
  await expect(page.getByText("Pin a mandate document")).toBeVisible();

  await page.getByLabel("Document").setInputFiles({
    name: "buyer-thread.mbox",
    mimeType: "application/octet-stream",
    buffer: DOC_LATE,
  });
  const hex = sha256(DOC_LATE);
  await expect(page.getByText(hex)).toBeVisible();
  await page.getByLabel("Label").fill("Buyer email thread export");
  await page
    .getByRole("button", { name: `Commit ${hex.slice(0, 12)}…` })
    .click();

  // The block replaces the panel; the honesty line shows the gap between
  // the fresh commit and the 4-day-old post.
  await expect(page.getByText("Mandate committed")).toBeVisible();
  await expect(page.getByText(/committed just now, posted \d+d ago/)).toBeVisible();
  await expect(page.getByText("Pin a mandate document")).toHaveCount(0);
});

test("04 write-once: the second commit is refused and the hash does not move", async () => {
  const askId = seededAskUrl.split("/").pop()!;
  const before = sha256(DOC_LATE);

  // The guard, made to fail on purpose: the owner tries to swap documents.
  const res = await page.request.post(`/api/asks/${askId}/mandate`, {
    data: { docHash: "f".repeat(64), label: "the swap" },
  });
  expect(res.status()).toBe(409);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toContain("write-once");

  // The stored fingerprint is still the first one.
  const db = createClient({ url: `file:${DB_PATH}` });
  const rs = await db.execute({
    sql: `SELECT doc_hash, label FROM ask_mandates WHERE ask_id = ?`,
    args: [askId],
  });
  db.close();
  expect(rs.rows.length).toBe(1);
  expect(String(rs.rows[0].doc_hash)).toBe(before);
  expect(String(rs.rows[0].label)).toBe("Buyer email thread export");
});

test("05 malformed commits are 400; a non-owner is 403", async () => {
  // An unpinned ask of someone else's, for the negative cases.
  await page.goto("/");
  const href = await page
    .locator("li")
    .filter({ hasText: "Factory-floor multicam video" })
    .first()
    .locator("a")
    .first()
    .getAttribute("href");
  const bareAskId = href!.split("/").pop()!;

  // Bad hash shapes: the validator answers before ownership is even
  // checked. (Uppercase hex is not on this list; it normalizes.)
  for (const docHash of ["not-hex", "ab".repeat(31), ""]) {
    const res = await page.request.post(`/api/asks/${bareAskId}/mandate`, {
      data: { docHash, label: "x" },
    });
    expect(res.status(), `hash ${JSON.stringify(docHash)}`).toBe(400);
  }
  const noLabel = await page.request.post(`/api/asks/${bareAskId}/mandate`, {
    data: { docHash: "a".repeat(64), label: "   " },
  });
  expect(noLabel.status()).toBe(400);

  // A stranger with a valid payload: 403, and nothing lands.
  const other = await context.browser()!.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, STRANGER);
  const res = await otherPage.request.post(`/api/asks/${bareAskId}/mandate`, {
    data: { docHash: "a".repeat(64), label: "not mine" },
  });
  expect(res.status()).toBe(403);
  await other.close();

  const db = createClient({ url: `file:${DB_PATH}` });
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM ask_mandates WHERE ask_id = ?`,
    args: [bareAskId],
  });
  db.close();
  expect(Number(rs.rows[0].n)).toBe(0);
});

test("06 another user sees the record, not the controls", async () => {
  const other = await context.browser()!.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, STRANGER);

  // A pinned ask: the block, hash and honesty line included, but no file
  // input, no commit button, no add-later panel.
  await otherPage.goto(seededAskUrl);
  await expect(otherPage.getByText("Mandate committed")).toBeVisible();
  await expect(otherPage.getByText(`${sha256(DOC_LATE).slice(0, 12)}…`)).toBeVisible();
  await expect(otherPage.getByText(/committed .*, posted /)).toBeVisible();
  await expect(otherPage.getByText("Pin a mandate document")).toHaveCount(0);
  await expect(otherPage.locator('input[type="file"]')).toHaveCount(0);
  await expect(otherPage.getByRole("button", { name: /^Commit/ })).toHaveCount(0);

  // An unpinned ask of someone else's: no block and no panel either.
  await otherPage.goto("/");
  const href = await otherPage
    .locator("li")
    .filter({ hasText: "Factory-floor multicam video" })
    .first()
    .locator("a")
    .first()
    .getAttribute("href");
  await otherPage.goto(href!);
  await expect(otherPage.getByText("Mandate committed")).toHaveCount(0);
  await expect(otherPage.getByText("Pin a mandate document")).toHaveCount(0);

  await other.close();
});

test("07 the word is mandate committed, never verified", async () => {
  // Every mandate surface: both ask pages (block + honesty line), the board
  // with its marks, and the compose form's pin section.
  for (const url of [newAskUrl, seededAskUrl]) {
    await page.goto(url);
    await expect(page.getByText("Mandate committed")).toBeVisible();
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body.toLowerCase()).not.toContain("verified");
  }

  await page.goto("/");
  await expect(page.getByText("mandate", { exact: true }).first()).toBeVisible();
  let body = (await page.locator("body").textContent()) ?? "";
  expect(body.toLowerCase()).not.toContain("verified");

  await page.goto("/new");
  await expect(page.getByText("Pin a mandate document")).toBeVisible();
  body = (await page.locator("body").textContent()) ?? "";
  expect(body.toLowerCase()).not.toContain("verified");
});

/**
 * Every cell of every table, scanned for the opening bytes of the two
 * documents this spec hashed. Returns "table.col" for each hit; the honest
 * state of the database is an empty list.
 */
async function scanForDocumentBytes(): Promise<string[]> {
  const needles = [
    DOC_AT_POST.toString("utf8").slice(0, 40),
    DOC_LATE.toString("utf8").slice(0, 40),
  ];
  const db = createClient({ url: `file:${DB_PATH}` });
  const tablesRs = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const hits: string[] = [];
  for (const t of tablesRs.rows.map((r) => String(r.name))) {
    const rs = await db.execute(`SELECT * FROM "${t}"`);
    for (const row of rs.rows) {
      for (const col of rs.columns) {
        const value = String(row[col] ?? "");
        if (needles.some((n) => value.includes(n))) hits.push(`${t}.${col}`);
      }
    }
  }
  db.close();
  return hits;
}

test("08 the database holds fingerprints, never documents", async () => {
  const db = createClient({ url: `file:${DB_PATH}` });
  const mandates = await db.execute(`SELECT ask_id, doc_hash, label FROM ask_mandates`);
  // Two seeded + two committed in this spec.
  expect(mandates.rows.length).toBe(4);
  for (const row of mandates.rows) {
    expect(String(row.doc_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row.label).length).toBeLessThanOrEqual(80);
  }
  db.close();

  // No cell in any table contains the document bytes this spec hashed.
  expect(await scanForDocumentBytes()).toEqual([]);
});

test("09 the scan is proven sensitive: a planted sentinel row is flagged", async () => {
  // The guard made to fail on purpose. Plant a row in ask_mandates whose
  // label carries actual document bytes (the exact leak the feature promises
  // cannot happen), and the scan from 08 must flag it. Bypasses the API on
  // purpose: the API refuses this, so the plant goes in the back door.
  const db = createClient({ url: `file:${DB_PATH}` });
  const askRs = await db.execute(
    `SELECT id FROM asks
      WHERE id NOT IN (SELECT ask_id FROM ask_mandates)
      LIMIT 1`,
  );
  const plantedAskId = String(askRs.rows[0].id);
  try {
    await db.execute({
      sql: `INSERT INTO ask_mandates (ask_id, doc_hash, label, committed_at)
            VALUES (?, ?, ?, ?)`,
      args: [
        plantedAskId,
        sha256(DOC_AT_POST),
        `leaked: ${DOC_AT_POST.toString("utf8").slice(0, 60)}`,
        Date.now(),
      ],
    });
    const flagged = await scanForDocumentBytes();
    expect(flagged).toContain("ask_mandates.label");
  } finally {
    await db.execute({
      sql: `DELETE FROM ask_mandates WHERE ask_id = ?`,
      args: [plantedAskId],
    });
    db.close();
  }
  // The plant is gone; the database is honest again.
  expect(await scanForDocumentBytes()).toEqual([]);
});
