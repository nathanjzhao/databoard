/**
 * tests/flow.spec.ts
 *
 * The whole product, driven end to end through the real UI, finishing with
 * the claim the product is built on: none of the PII typed during the run is
 * anywhere in the database file.
 *
 * PRECONDITION: a freshly reset, seeded local database, and a dev server
 * started AFTER the reset:
 *
 *   npm run reset-db && npm run seed
 *   npx playwright test          # playwright.config.ts starts/reuses :3947
 *
 * If a dev server was already running when reset-db deleted data/app.db, it
 * keeps writing to the deleted inode while this spec reads the new file;
 * restart the server after any reset or the run will fail at signup.
 *
 * The spec is serial on purpose. It signs up two users with fixed contacts
 * (one account per contact is enforced by a blind index, so re-running
 * against a dirty DB fails at signup, loudly, which is correct).
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { promises as fs } from "node:fs";
import path from "node:path";
import { KNOWN_BUYERS } from "../lib/buyers";

const ROOT = path.resolve(__dirname, "..");
const VERIFY_DIR = path.join(ROOT, "verify");
const DB_PATH = path.join(ROOT, "data", "app.db");

/* ------------------------------------------------------------- test data */

const USER_A = {
  realName: "Alice Chen",
  org: "Redwood Data Co",
  contact: "4155551234",
  username: "verifier-ash",
  password: "ash-verifies-boards",
};

const USER_B = {
  realName: "Bob Diaz",
  contact: "bob.diaz.test@example.com",
  username: "verifier-bay",
  password: "bay-verifies-boards",
};

const ASK_A = {
  title: "Kitchen teleop trajectories for a manipulation benchmark",
  category: "RL environment seed data",
  buyer: "Anthropic",
  pct: 30,
  description:
    "Teleoperated pick-and-place in real kitchens, 6-DoF end effector, per-step gripper state. Reset markers required.",
};

const ASK_B = {
  title: "Graded rollouts from household manipulation policies",
  category: "Eval / benchmark data",
  buyer: "Anthropic",
  pct: 20,
  description:
    "Held-out rollouts with human pass/fail grades and failure taxonomy labels. Never posted publicly.",
};

const COLLAB_NOTE =
  "Holding about 1.5k graded rollouts from the same task family. Covers roughly half your remaining gap.";
const MSG_FROM_A =
  "Your note reads like the right task family. Can you cover half the remaining gap by end of month?";
const MEETUP_SNIPPET = "Suggesting we take the specifics off-platform";

/* ------------------------------------------------------- shared run state */

let context: BrowserContext;
let page: Page;
let askAUrl = "";
let askBUrl = "";
let threadId = "";

async function shot(p: Page, name: string) {
  await p.screenshot({ path: path.join(VERIFY_DIR, name), fullPage: true });
}

/* ---------------------------------------------------------- UI helpers */

/** Signup, all four screens, reading the demo code off the page like a user. */
async function signUp(
  p: Page,
  opts: {
    realName: string;
    org?: string; // omitted = independent individual
    contact: string;
    username: string;
    password: string;
    codeShot?: string;
    doneShot?: string;
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

  // Demo mode shows the code on screen with a labeled note. Read it from the
  // UI, retype it, and continue: the stateless challenge round-trip for real.
  await expect(p.getByText("Type the code back")).toBeVisible();
  await expect(p.getByText("Demo mode", { exact: true })).toBeVisible();
  const demoCode = (await p.getByText(/^\d{6}$/).first().textContent())?.trim() ?? "";
  expect(demoCode).toMatch(/^\d{6}$/);
  if (opts.codeShot) await shot(p, opts.codeShot);

  const codeInput = p.getByLabel("Six digit code");
  await codeInput.fill("");
  await codeInput.fill(demoCode);
  await p.getByRole("button", { name: "Continue" }).click();

  await expect(p.getByText("Pick what we actually keep")).toBeVisible();
  await p.getByLabel("Password").fill(opts.password);
  await p.getByRole("button", { name: "Create account" }).click();

  // The handle is assigned by the server and shown once on the done screen.
  // Read it back into opts so everything downstream uses the real one.
  const handle =
    (await p.getByTestId("assigned-handle").textContent({ timeout: 15_000 }))
      ?.replace(/^@/, "")
      .trim() ?? "";
  expect(handle).toMatch(/^[a-z0-9][a-z0-9_-]{2,23}$/);
  opts.username = handle;
  await p.getByRole("button", { name: "Go to the board" }).click();
  await expect(p.getByText(`@${opts.username}`).first()).toBeVisible({
    timeout: 15_000,
  });
  if (opts.doneShot) await shot(p, opts.doneShot);
}

async function signOut(p: Page) {
  await p.getByRole("button", { name: "Sign out" }).click();
  await p.waitForURL(/\/gate$/);
}

async function logIn(p: Page, username: string, password: string) {
  await p.goto("/login");
  await p.getByLabel("Handle").fill(username);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname === "/");
  await expect(p.getByText(`@${username}`).first()).toBeVisible();
}

/** React-controlled <input type=range>: set the value natively, fire input. */
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

/** Post an ask through /new and return its /ask/<id> URL. */
async function postAsk(p: Page, ask: typeof ASK_A): Promise<string> {
  await p.goto("/new");
  await p.getByLabel("Title").fill(ask.title);
  await p.getByLabel("Category").selectOption({ label: ask.category });
  await p.getByLabel("Description").fill(ask.description);
  await setSlider(p, "Percent of supply already filled", ask.pct);
  await expect(p.getByText("Supply already filled")).toBeVisible();
  await p.getByLabel("Buying lab").selectOption(ask.buyer);
  await p.getByText("Non-exclusive", { exact: true }).click();
  await p.getByRole("button", { name: "Post to the board" }).click();
  await p.waitForURL(/\/ask\/[^/]+$/);
  await expect(p.getByRole("heading", { name: ask.title })).toBeVisible();
  return p.url();
}

/** The visible "#xxxx" buyer chip text inside a board row for a title. */
async function boardChip(p: Page, title: string): Promise<string> {
  const row = p.locator("li").filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  const chips = await row.getByText(/^#[0-9a-f]{4}$/).allTextContents();
  expect(chips.length).toBeGreaterThan(0);
  // Desktop and mobile render the same chip; they must agree.
  expect(new Set(chips).size).toBe(1);
  return chips[0];
}

/* ------------------------------------------------------------- the flow */

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await fs.mkdir(VERIFY_DIR, { recursive: true });
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("00 gate: logged-out / redirects, /transparency public, /messages gated", async ({
  browser,
}) => {
  const anon = await browser.newContext();
  const p = await anon.newPage();

  await p.goto("/");
  await expect(p).toHaveURL(/\/gate$/);
  await expect(p.getByText("DataBoard").first()).toBeVisible();
  await shot(p, "01-gate.png");

  await p.goto("/transparency");
  await expect(p).toHaveURL(/\/transparency$/);
  await expect(p.locator("body")).toContainText("CREATE TABLE IF NOT EXISTS users");
  await shot(p, "02-transparency-public.png");

  await p.goto("/messages");
  await expect(p).toHaveURL(/\/gate$/);

  await anon.close();
});

test("01 user A signs up: org account, phone contact, demo code from the UI", async () => {
  // Pass the user object itself: signUp writes the assigned handle back.
  await signUp(
    page,
    Object.assign(USER_A, {
      codeShot: "03-signup-a-code.png",
      doneShot: "04-signup-a-done.png",
    }),
  );

  // Landed logged in: the gated board renders with A's handle in the chrome.
  await page.goto("/");
  await expect(page).toHaveURL((u) => u.pathname === "/");
  await expect(page.getByText("Somebody wants your data.")).toBeVisible();
  await expect(page.getByText(`@${USER_A.username}`).first()).toBeVisible();
});

test("02 user A posts an ask naming Anthropic at 30% filled", async () => {
  askAUrl = await postAsk(page, ASK_A);
  await expect(page.getByText("Supply filled").first()).toBeVisible();
  await expect(page.getByText(`${ASK_A.pct}%`).first()).toBeVisible();
  await shot(page, "05-ask-a-posted.png");
});

test("03 log out; user B signs up individual with email and posts a second Anthropic ask", async () => {
  await signOut(page);
  await signUp(page, Object.assign(USER_B, { doneShot: "06-signup-b-done.png" }));
  askBUrl = await postAsk(page, ASK_B);
  await shot(page, "07-ask-b-posted.png");
  expect(askBUrl).not.toBe(askAUrl);
});

test("04 board shows both asks with the same Buyer # chip and correct meters", async () => {
  await page.goto("/");

  const chipA = await boardChip(page, ASK_A.title);
  const chipB = await boardChip(page, ASK_B.title);
  expect(chipA).toMatch(/^#[0-9a-f]{4}$/);
  expect(chipA).toBe(chipB);

  // Cross-process consistency: the seeded Anthropic ask minted its token in a
  // separate node process and must collide with the ones minted via the API.
  const chipSeed = await boardChip(
    page,
    "Contested-topic preference pairs, expert-rated",
  );
  expect(chipSeed).toBe(chipA);

  // Supply meters, per row.
  const rowA = page.locator("li").filter({ hasText: ASK_A.title }).first();
  const rowB = page.locator("li").filter({ hasText: ASK_B.title }).first();
  await expect(rowA.getByText(`${ASK_A.pct}%`).first()).toBeVisible();
  await expect(rowB.getByText(`${ASK_B.pct}%`).first()).toBeVisible();

  await shot(page, "08-board-both-asks.png");
});

test("05 B's /matches shows the overlap with A; B requests collab on A's ask", async () => {
  await page.goto("/matches");
  await expect(page.getByText("Buyer overlap")).toBeVisible();
  await expect(page.getByText(ASK_A.title)).toBeVisible();
  await expect(page.getByText(`@${USER_A.username}`).first()).toBeVisible();
  await shot(page, "09-matches-b-overlap.png");

  await page.goto(askAUrl);
  await page.getByLabel("Note to the poster, optional").fill(COLLAB_NOTE);
  await page.getByRole("button", { name: "Request to collaborate" }).click();
  await expect(page.getByText("Request sent", { exact: true })).toBeVisible();
  await shot(page, "10-collab-requested.png");
});

test("06 A logs back in, accepts on /matches, and messages B in the thread", async () => {
  await signOut(page);
  await logIn(page, USER_A.username, USER_A.password);

  await page.goto("/matches");
  await expect(page.getByText("Needs a decision")).toBeVisible();
  await expect(page.getByText(`@${USER_B.username}`).first()).toBeVisible();
  await expect(page.getByText(COLLAB_NOTE)).toBeVisible();
  await shot(page, "11-matches-a-inbox.png");

  await page.getByRole("button", { name: "Accept and open a thread" }).click();
  await page.waitForURL(/\/messages\/[^/]+$/);
  threadId = page.url().split("/messages/")[1];
  expect(threadId.length).toBeGreaterThan(0);
  await expect(page.getByText("Standing advice")).toBeVisible();

  await page
    .getByPlaceholder("Plain text. Enter sends, Shift+Enter for a new line.")
    .fill(MSG_FROM_A);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("ol")).toContainText(MSG_FROM_A);
  await expect(page.locator("ol")).toContainText(`@${USER_A.username}`);
  await shot(page, "12-thread-a-message.png");
});

test("07 B reads the message and uses the suggest-a-meetup button", async () => {
  await signOut(page);
  await logIn(page, USER_B.username, USER_B.password);

  await page.goto("/messages");
  await page.locator(`a[href="/messages/${threadId}"]`).first().click();
  await page.waitForURL(/\/messages\/[^/]+$/);

  // B reads A's message.
  await expect(page.locator("ol")).toContainText(MSG_FROM_A);

  // The meetup button drops the template into the composer, never auto-sends.
  const composer = page.getByPlaceholder(
    "Plain text. Enter sends, Shift+Enter for a new line.",
  );
  await page.getByRole("button", { name: "Suggest a meetup" }).click();
  await expect(composer).toHaveValue(new RegExp(MEETUP_SNIPPET));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("ol")).toContainText(MEETUP_SNIPPET);
  await expect(composer).toHaveValue("");
  await shot(page, "13-thread-b-meetup.png");
});

test("08 /transparency renders the schema; the API serves it as text/plain", async ({
  request,
}) => {
  await page.goto("/transparency");
  await expect(page.locator("body")).toContainText("CREATE TABLE IF NOT EXISTS users");
  await expect(page.locator("body")).toContainText("contact_blind_index");
  await shot(page, "14-transparency-schema.png");

  const res = await request.get("/api/transparency/schema");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/plain");
  const body = await res.text();
  expect(body).toContain("CREATE TABLE IF NOT EXISTS users");
  expect(body).toContain("CREATE TABLE IF NOT EXISTS messages");
});

/* --------------------------------------------------- the privacy claim */

test("09 THE PRIVACY CLAIM: no PII string appears in any row of any table", async () => {
  // Everything typed during this run that must never be persisted, plus the
  // normalized forms the server computes before HMAC-ing, plus every known
  // buyer name and its normalized form, plus the seed users' contacts.
  const literals = [
    USER_A.contact, // "4155551234"
    "1" + USER_A.contact, // +1 form
    USER_B.contact, // full email
    "bob.diaz.test",
    USER_A.realName,
    "alicechen",
    USER_B.realName,
    "bobdiaz",
    USER_A.org,
    "redwooddataco",
    "example.com", // every raw contact in this run ends with it
    "4155550101", // seed contacts, normalized
    "4155550102",
    ...KNOWN_BUYERS,
    ...KNOWN_BUYERS.map((b) => b.toLowerCase().replace(/[^a-z0-9]+/g, "")),
  ];
  const forbidden = [...new Set(literals.map((s) => s.toLowerCase()))];

  // Opaque random identifiers (base64url row ids) are the one place a short
  // pattern like "xai" can appear by coin flip; they are random bytes, not
  // text, so 3-to-5-char patterns are skipped there. Every pattern still
  // applies in full to any value containing spaces, punctuation, or any
  // other shape a name, email, or phone number could actually take.
  const OPAQUE = /^[A-Za-z0-9_-]{16,}$/;

  const client = createClient({ url: `file:${DB_PATH}` });
  const tablesRs = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const tables = tablesRs.rows.map((r) => String(r.name));
  expect(tables.sort()).toEqual([
    "ask_activity",
    "ask_closures",
    "ask_mandates",
    "ask_terms",
    "asks",
    "collab_requests",
    "deal_participants",
    "deals",
    "hidden_asks",
    "messages",
    "operators",
    "ops_errors",
    "rate_limits",
    "sessions",
    "thread_keys",
    "thread_participants",
    "threads",
    "user_e2ee_keys",
    "users",
  ]);

  const violations: string[] = [];
  const rowCounts: Record<string, number> = {};

  for (const table of tables) {
    const rs = await client.execute(`SELECT * FROM "${table}"`);
    rowCounts[table] = rs.rows.length;
    for (const row of rs.rows) {
      for (const col of rs.columns) {
        const raw = (row as Record<string, unknown>)[col];
        if (raw == null) continue;
        const value = String(raw);
        const lower = value.toLowerCase();
        const opaque = OPAQUE.test(value);
        for (const pat of forbidden) {
          if (opaque && pat.length < 6) continue;
          if (lower.includes(pat)) {
            violations.push(
              `${table}.${col} contains "${pat}": ${value.slice(0, 100)}`,
            );
          }
        }
      }
    }
  }
  client.close();

  // The scan must have looked at real data, not an empty husk: 6 seed users
  // + A + B, 10 seed asks + 2 posted here, the accepted collab, the thread,
  // and both messages sent above.
  expect(rowCounts.users).toBeGreaterThanOrEqual(8);
  expect(rowCounts.asks).toBeGreaterThanOrEqual(12);
  expect(rowCounts.collab_requests).toBeGreaterThanOrEqual(1);
  expect(rowCounts.threads).toBeGreaterThanOrEqual(1);
  expect(rowCounts.thread_participants).toBeGreaterThanOrEqual(2);
  expect(rowCounts.messages).toBeGreaterThanOrEqual(2);

  expect(violations, "PII found in the database").toEqual([]);

  // Belt and braces: the same scan over the raw bytes of the sqlite file and
  // its WAL sidecars, so free pages and half-checkpointed frames count too.
  const rawForbidden = forbidden.filter((p) => p.length >= 6);
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = DB_PATH + suffix;
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch {
      continue; // sidecar not present
    }
    const haystack = bytes.toString("latin1").toLowerCase();
    for (const pat of rawForbidden) {
      expect(
        haystack.includes(pat),
        `raw bytes of ${path.basename(file)} contain "${pat}"`,
      ).toBe(false);
    }
  }
});
