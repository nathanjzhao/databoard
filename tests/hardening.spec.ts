/**
 * tests/hardening.spec.ts
 *
 * Proof suite for the hardening work: rate limits, non-demo OTP delivery,
 * moderation, the public legal pages, error capture + backup/restore, and
 * the privacy regression over every table the hardening added.
 *
 * PRECONDITION: same as flow.spec.ts. Fresh `npm run reset-db && npm run
 * seed`, dev server started after the reset (the playwright config's
 * webServer, or PW_PORT pointing at one you started). Runs after
 * deals/flow in file order and leaves the board the way it found it
 * (hidden asks restored), so responsive/trust stay green behind it.
 *
 * THE ENV DANCE for the non-demo OTP tests: BLIND_TENDER_DEMO and
 * OTP_TEST_CAPTURE are read at module load in lib/verify.ts, so they cannot
 * be flipped on a running server. This spec therefore spawns its own dev
 * servers via child_process on ports 3963/3964:
 *
 *   :3963  BLIND_TENDER_DEMO=false OTP_TEST_CAPTURE=1   live mode, the test
 *          transport appends {kind, code} to data/otp-capture.jsonl
 *   :3964  BLIND_TENDER_DEMO=false, no capture, and RESEND_API_KEY /
 *          TWILIO_* scrubbed from the child env: live mode with no way to
 *          deliver anything
 *
 * Next 16 refuses two dev servers over one distDir (the single-instance
 * lock lives at distDir/lock), so next.config.ts honors NEXT_TEST_DIST_DIR
 * and each spawned server gets its own throwaway .next-test-* directory.
 * Both children share data/app.db with the main server, which is also what
 * lets the final privacy scan cover everything they wrote. Assumes the
 * local .env.local does not configure a real delivery provider.
 */

import { test, expect, request as pwRequest, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "app.db");
const CAPTURE_PATH = path.join(ROOT, "data", "otp-capture.jsonl");

const CAPTURE_PORT = 3963;
const NO_PROVIDER_PORT = 3964;

/* ------------------------------------------------------------- test data */

// TEST-NET-2 addresses: never routable, never a real client.
const XFF_OTP = "198.51.100.21";
const XFF_LOGIN = "198.51.100.22";
const XFF_CONTROL = "198.51.100.23";

const HAMMER_CONTACT_A = "hammer-alpha@example.net";
const HAMMER_CONTACT_B = "hammer-beta@example.net";
const CONTROL_CONTACT = "hammer-control@example.net";
const HAMMER_HANDLE = "hammer-dummy";

const OTP_CONTACT = "otp-live-proof@example.net";
const NO_PROVIDER_EMAIL = "no-provider-proof@example.net";
const NO_PROVIDER_PHONE = "+1 415 555 0123";

const RUN_TAG = Date.now().toString(36);
const QUERY_MARKER = `qmarker${RUN_TAG}`;
const BODY_MARKER = `bmarker${RUN_TAG}`;
const HIDE_REASON = "Solicits off-board contact. Hardening proof run.";

const HIDDEN_TITLE = "Non-English clinical reasoning evals, physician-written";
const POSTER = "cold-copy"; // owns HIDDEN_TITLE (seed)
const OPERATOR = "quiet-ledger"; // seeded operator
const THIRD = "vellum"; // neither poster nor operator
const DEMO_PASSWORD = "demo-demo-demo";

/** OTP codes read from the capture file, scanned for in the privacy test. */
const capturedCodes: string[] = [];

/* ------------------------------------------------------------ DB helpers */

type DbDump = {
  tables: string[];
  values: { table: string; col: string; value: string }[];
};

async function dumpDb(): Promise<DbDump> {
  const client = createClient({ url: `file:${DB_PATH}` });
  const tablesRs = await client.execute(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'`,
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

function scanDump(dump: DbDump, pattern: string): string[] {
  const p = pattern.toLowerCase();
  return dump.values
    .filter((v) => v.value.toLowerCase().includes(p))
    .map((v) => `${v.table}.${v.col}: ${v.value.slice(0, 80)}`);
}

/** The raw file bytes, WAL sidecars included: catches even deleted rows. */
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

/**
 * Zero every rate-limit counter. The whole CI run fits inside one 5-minute
 * limiter window, and every browser login in every suite shares the "local"
 * per-IP bucket, so the hammer tests below would otherwise (a) inherit
 * whatever deals/flow spent before them and (b) leave the shared buckets
 * nearly full for responsive/trust behind them. Counters are not evidence;
 * both hammer runs recreate what they assert from empty.
 */
async function clearRateLimits(): Promise<void> {
  const client = createClient({ url: `file:${DB_PATH}` });
  await client.execute(`DELETE FROM rate_limits`);
  client.close();
}

async function askIdByTitle(title: string): Promise<string> {
  const client = createClient({ url: `file:${DB_PATH}` });
  const rs = await client.execute({
    sql: `SELECT id FROM asks WHERE title = ?`,
    args: [title],
  });
  client.close();
  expect(rs.rows.length, `seeded ask "${title}" must exist`).toBe(1);
  return String(rs.rows[0].id);
}

async function opsErrorRows(): Promise<Record<string, string>[]> {
  const client = createClient({ url: `file:${DB_PATH}` });
  const rs = await client.execute(
    `SELECT * FROM ops_errors ORDER BY at DESC LIMIT 200`,
  );
  client.close();
  return rs.rows.map((row) => {
    const obj: Record<string, string> = {};
    for (const col of rs.columns) {
      const v = (row as Record<string, unknown>)[col];
      obj[col] = v == null ? "" : String(v);
    }
    return obj;
  });
}

async function tableCounts(dbFile: string): Promise<Map<string, number>> {
  const client = createClient({ url: `file:${dbFile}` });
  const tablesRs = await client.execute(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'
      ORDER BY name`,
  );
  const counts = new Map<string, number>();
  for (const row of tablesRs.rows) {
    const table = String(row.name);
    const rs = await client.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
    counts.set(table, Number(rs.rows[0].n));
  }
  client.close();
  return counts;
}

/* ------------------------------------------------------------ UI helpers */

async function logIn(p: Page, username: string, password: string) {
  await p.goto("/login");
  await p.getByLabel("Handle").fill(username);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname === "/");
  await expect(p.getByText(`@${username}`).first()).toBeVisible();
}

/* ----------------------------------------------------------- API bursts */

type BurstHit = { status: number; retryAfterSeconds?: number; error?: string };

async function burst(
  ctx: APIRequestContext,
  url: string,
  data: Record<string, string>,
  n: number,
): Promise<BurstHit[]> {
  const out: BurstHit[] = [];
  for (let i = 0; i < n; i++) {
    const res = await ctx.post(url, { data });
    const json = (await res.json().catch(() => ({}))) as {
      retryAfterSeconds?: number;
      error?: string;
    };
    out.push({ status: res.status(), ...json });
  }
  return out;
}

function xffContext(baseURL: string, ip: string): Promise<APIRequestContext> {
  // The dev server has no proxy in front, so x-forwarded-for is taken at
  // face value; each synthetic TEST-NET address gets its own IP bucket and
  // the shared "local" bucket the later suites depend on stays untouched.
  return pwRequest.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": ip },
  });
}

/* -------------------------------------------------------- spawned servers */

type Spawned = { child: ChildProcess; port: number; log: string[] };

async function spawnDevServer(
  port: number,
  distDir: string,
  extraEnv: Record<string, string>,
): Promise<Spawned> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_TEST_DIST_DIR: distDir,
  };
  // Live mode must actually be undeliverable unless extraEnv says otherwise.
  for (const k of [
    "RESEND_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM",
    "OTP_TEST_CAPTURE",
    "BLIND_TENDER_DB",
  ]) {
    delete env[k];
  }
  Object.assign(env, extraEnv);

  const nextBin = path.join(ROOT, "node_modules", ".bin", "next");
  const child = spawn(nextBin, ["dev", "--port", String(port)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const log: string[] = [];
  child.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => log.push(d.toString()));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/gate`);
      if (res.ok) return { child, port, log };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `dev server on :${port} never became ready\n${log.join("").slice(-4000)}`,
  );
}

async function killDevServer(s: Spawned | undefined): Promise<void> {
  const pid = s?.child.pid;
  if (!s || !pid) return;
  const closed = new Promise<void>((resolve) => s.child.once("close", () => resolve()));
  try {
    process.kill(-pid, "SIGTERM"); // whole process group
  } catch {
    s.child.kill("SIGTERM");
  }
  await Promise.race([closed, new Promise((r) => setTimeout(r, 8000))]);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/* ======================================================== 1  RATE LIMITS */

test.describe("rate limits", () => {
  test.beforeAll(async () => {
    await clearRateLimits(); // deterministic budgets for the hammers
  });

  test.afterAll(async () => {
    await clearRateLimits(); // hand the shared buckets back to later suites
  });

  test("request-code trips per contact at 429 and a different contact still passes", async ({
    baseURL,
  }) => {
    const ctx = await xffContext(baseURL!, XFF_OTP);
    try {
      // Limit is 5/10min per contact. Five pass, the sixth trips.
      const hits = await burst(
        ctx,
        "/api/auth/request-code",
        { contact: HAMMER_CONTACT_A, realName: "Hammer Proof", affiliation: "Hammer Lab" },
        6,
      );
      for (const h of hits.slice(0, 5)) expect(h.status).toBe(200);
      const tripped = hits[5];
      expect(tripped.status).toBe(429);
      expect(tripped.error).toMatch(/Too many codes requested\. Try again in/);
      expect(typeof tripped.retryAfterSeconds).toBe("number");
      expect(tripped.retryAfterSeconds!).toBeGreaterThanOrEqual(1);
      expect(tripped.retryAfterSeconds!).toBeLessThanOrEqual(600);

      // Same IP, different contact: goes straight through. The bucket is
      // per contact, not global and not per IP alone.
      const other = await burst(
        ctx,
        "/api/auth/request-code",
        { contact: HAMMER_CONTACT_B, realName: "Hammer Proof", affiliation: "Hammer Lab" },
        1,
      );
      expect(other[0].status).toBe(200);
    } finally {
      await ctx.dispose();
    }
  });

  test("negative control: below the limit the same guard never fires", async ({
    baseURL,
  }) => {
    // The hammer, deliberately under the limit (4 < 5). Zero 429s proves the
    // previous test's detector distinguishes tripped from not-tripped
    // instead of passing on anything.
    const ctx = await xffContext(baseURL!, XFF_CONTROL);
    try {
      const hits = await burst(
        ctx,
        "/api/auth/request-code",
        { contact: CONTROL_CONTACT, realName: "Hammer Proof", affiliation: "Hammer Lab" },
        4,
      );
      expect(hits.filter((h) => h.status === 429)).toEqual([]);
      for (const h of hits) expect(h.status).toBe(200);
    } finally {
      await ctx.dispose();
    }
  });

  test("login trips per handle at 429 and the /login UI shows the copy", async ({
    baseURL,
    browser,
  }) => {
    const ctx = await xffContext(baseURL!, XFF_LOGIN);
    try {
      // Limit is 10/5min per handle. Ten wrong passwords are 401s, the
      // eleventh is refused before the password is even checked.
      const hits = await burst(
        ctx,
        "/api/auth/login",
        { username: HAMMER_HANDLE, password: "wrong-password-every-time" },
        11,
      );
      for (const h of hits.slice(0, 10)) expect(h.status).toBe(401);
      const tripped = hits[10];
      expect(tripped.status).toBe(429);
      expect(tripped.error).toMatch(/Too many attempts\. Try again in/);
      expect(typeof tripped.retryAfterSeconds).toBe("number");
      expect(tripped.retryAfterSeconds!).toBeGreaterThanOrEqual(1);

      // The login form surfaces the 429 body verbatim.
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("/login");
      await page.getByLabel("Handle").fill(HAMMER_HANDLE);
      await page.getByLabel("Password").fill("still-wrong");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(
        page.getByText(/Too many attempts\. Try again in/),
      ).toBeVisible();
      await context.close();
    } finally {
      await ctx.dispose();
    }
  });
});

/* ==================================================== 2  NON-DEMO OTP */

test.describe("non-demo OTP, test-capture transport", () => {
  let server: Spawned | undefined;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await fs.rm(CAPTURE_PATH, { force: true });
    server = await spawnDevServer(CAPTURE_PORT, `.next-test-otp-${CAPTURE_PORT}`, {
      BLIND_TENDER_DEMO: "false",
      OTP_TEST_CAPTURE: "1",
    });
  });

  test.afterAll(async () => {
    await killDevServer(server);
  });

  test("email signup succeeds end to end with the code read from the capture file, and the UI never shows a demo code", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60_000); // cold distDir: first compile is slow

    await page.goto(`http://localhost:${CAPTURE_PORT}/signup`);
    await expect(page.getByText("Say who you are, once")).toBeVisible();
    await page.getByLabel("Real name").fill("Olive Proof");
    await page.getByRole("button", { name: "An organization" }).click();
    await page.getByPlaceholder("Org name").fill("Hardening Proof Lab");
    await page.getByLabel("Phone or email").fill(OTP_CONTACT);

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes("/api/auth/request-code"),
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Send me a code" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const issued = (await response.json()) as {
      demo: boolean;
      demoCode?: string;
      transport: string;
    };
    expect(issued.demo).toBe(false);
    expect(issued.demoCode).toBeUndefined();
    expect(issued.transport).toBe("test");

    // The code screen, without the demo crutch: no label, no visible code.
    await expect(page.getByText("Type the code back")).toBeVisible();
    await expect(page.getByText("Demo mode")).toHaveCount(0);
    await expect(page.getByText(/^\d{6}$/)).toHaveCount(0);

    // The code went to the capture file instead of a provider, kind + code
    // only, never the contact.
    const captured = (await fs.readFile(CAPTURE_PATH, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; code: string });
    const last = captured[captured.length - 1];
    expect(last.kind).toBe("email");
    expect(last.code).toMatch(/^\d{6}$/);
    capturedCodes.push(last.code);
    expect(JSON.stringify(captured)).not.toContain(OTP_CONTACT);

    await page.getByLabel("Six digit code").fill(last.code);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Pick what we actually keep")).toBeVisible();
    await page.getByLabel("Password").fill("otp-proof-password-1");
    await page.getByRole("button", { name: "Create account" }).click();

    const handle =
      (await page.getByTestId("assigned-handle").textContent({ timeout: 15_000 }))
        ?.replace(/^@/, "")
        .trim() ?? "";
    expect(handle).toMatch(/^[a-z0-9][a-z0-9_-]{2,23}$/);
    await context.close();
  });
});

test.describe("non-demo OTP, no provider configured", () => {
  let server: Spawned | undefined;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    server = await spawnDevServer(
      NO_PROVIDER_PORT,
      `.next-test-otp-${NO_PROVIDER_PORT}`,
      { BLIND_TENDER_DEMO: "false" },
    );
  });

  test.afterAll(async () => {
    await killDevServer(server);
  });

  test("request-code returns 503 when neither a provider nor the capture transport exists", async () => {
    test.setTimeout(120_000);
    const ctx = await pwRequest.newContext({
      baseURL: `http://localhost:${NO_PROVIDER_PORT}`,
    });
    try {
      const res = await ctx.post("/api/auth/request-code", {
        data: {
          contact: NO_PROVIDER_EMAIL,
          realName: "Nadia Proof",
          affiliation: "Hardening Proof Lab",
        },
      });
      expect(res.status()).toBe(503);
      const json = (await res.json()) as { error: string; contactKinds: string[] };
      expect(json.error).toContain("Email delivery is not configured");
      expect(json.contactKinds).toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });

  test("with no Twilio env the phone path is visibly unavailable in the signup UI", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60_000);
    await page.goto(`http://localhost:${NO_PROVIDER_PORT}/signup`);
    await page.getByLabel("Real name").fill("Nadia Proof");
    await page.getByRole("button", { name: "An organization" }).click();
    await page.getByPlaceholder("Org name").fill("Hardening Proof Lab");
    await page.getByLabel("Phone or email").fill(NO_PROVIDER_PHONE);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await expect(page.getByText("SMS delivery is not configured.")).toBeVisible();
    // Still on the identity step: nothing was issued.
    await expect(page.getByText("Say who you are, once")).toBeVisible();
    await context.close();
  });
});

/* ====================================================== 3  MODERATION */

test.describe("moderation", () => {
  let opCtx: BrowserContext, opPage: Page;
  let posterCtx: BrowserContext, posterPage: Page;
  let thirdCtx: BrowserContext, thirdPage: Page;
  let askId = "";

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    askId = await askIdByTitle(HIDDEN_TITLE);
    opCtx = await browser.newContext();
    opPage = await opCtx.newPage();
    await logIn(opPage, OPERATOR, DEMO_PASSWORD);
    posterCtx = await browser.newContext();
    posterPage = await posterCtx.newPage();
    await logIn(posterPage, POSTER, DEMO_PASSWORD);
    thirdCtx = await browser.newContext();
    thirdPage = await thirdCtx.newPage();
    await logIn(thirdPage, THIRD, DEMO_PASSWORD);
  });

  test.afterAll(async () => {
    await opCtx?.close();
    await posterCtx?.close();
    await thirdCtx?.close();
  });

  test("the operator hides a seeded ask with a reason, from the ask page", async () => {
    // Sanity first, so the disappearance assertions below mean something.
    await opPage.goto("/");
    await expect(opPage.getByText(HIDDEN_TITLE).first()).toBeVisible();
    await opPage.goto("/matches");
    await expect(opPage.getByText(HIDDEN_TITLE).first()).toBeVisible();

    await opPage.goto(`/ask/${askId}`);
    await expect(opPage.getByRole("heading", { name: HIDDEN_TITLE })).toBeVisible();
    await opPage.getByRole("button", { name: "Hide", exact: true }).click();
    await opPage.getByLabel(/Reason\. The poster reads it/).fill(HIDE_REASON);
    await opPage.getByRole("button", { name: "Hide from the board" }).click();
    await expect(opPage.getByText("hidden by moderation").first()).toBeVisible();
  });

  test("the board and matches no longer show the hidden ask", async () => {
    await opPage.goto("/");
    await expect(opPage.getByText(HIDDEN_TITLE)).toHaveCount(0);
    // quiet-ledger's OpenAI ask matched cold-copy's before the hide; the
    // overlap is gone from /matches now.
    await opPage.goto("/matches");
    await expect(opPage.getByText(HIDDEN_TITLE)).toHaveCount(0);
  });

  test("the poster still sees their ask, wearing the hidden banner and the reason", async () => {
    const res = await posterPage.goto(`/ask/${askId}`);
    expect(res?.status()).toBe(200);
    await expect(posterPage.getByRole("heading", { name: HIDDEN_TITLE })).toBeVisible();
    await expect(posterPage.getByText("hidden by moderation").first()).toBeVisible();
    await expect(posterPage.getByText(HIDE_REASON)).toBeVisible();
    // The poster cannot unhide.
    await expect(posterPage.getByRole("button", { name: "Unhide" })).toHaveCount(0);
    // And their own board view honestly drops the row too.
    await posterPage.goto("/");
    await expect(posterPage.getByText(HIDDEN_TITLE)).toHaveCount(0);
  });

  test("a third account gets a plain 404 on the hidden ask", async () => {
    const res = await thirdPage.goto(`/ask/${askId}`);
    expect(res?.status()).toBe(404);
  });

  test("a non-operator hitting the admin API is denied with the uniform body", async () => {
    const hide = await thirdPage.request.post(`/api/admin/asks/${askId}/hide`, {
      data: { reason: "should never land" },
    });
    expect(hide.status()).toBe(403);
    expect(await hide.json()).toEqual({ error: "Not found." });

    const list = await thirdPage.request.get("/api/admin/hidden");
    expect(list.status()).toBe(403);
    expect(await list.json()).toEqual({ error: "Not found." });

    const adminPage = await thirdPage.goto("/admin");
    expect(adminPage?.status()).toBe(404);
  });

  test("the admin page lists the hidden ask and unhide restores it everywhere", async () => {
    await opPage.goto("/admin");
    await expect(opPage.getByText("Hidden asks")).toBeVisible();
    await expect(opPage.getByRole("link", { name: HIDDEN_TITLE })).toBeVisible();
    await expect(opPage.getByText(HIDE_REASON)).toBeVisible();
    await expect(opPage.getByText(`by @${POSTER} · hidden by @${OPERATOR}`)).toBeVisible();

    await opPage.getByRole("button", { name: "Unhide" }).click();
    await expect(opPage.getByText("Nothing is hidden.")).toBeVisible();

    await opPage.goto("/");
    await expect(opPage.getByText(HIDDEN_TITLE).first()).toBeVisible();
    const res = await thirdPage.goto(`/ask/${askId}`);
    expect(res?.status()).toBe(200);
    await expect(thirdPage.getByRole("heading", { name: HIDDEN_TITLE })).toBeVisible();
  });
});

/* ========================================================= 4  LEGAL */

test.describe("legal pages", () => {
  test("/terms and /privacy render logged out", async ({ browser }) => {
    const context = await browser.newContext(); // no cookies at all
    const page = await context.newPage();

    const terms = await page.goto("/terms");
    expect(terms?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/terms");
    await expect(
      page.getByRole("heading", { name: "The terms, in plain language." }),
    ).toBeVisible();

    const privacy = await page.goto("/privacy");
    expect(privacy?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/privacy");
    await expect(
      page.getByRole("heading", { name: "The schema is the policy." }),
    ).toBeVisible();

    await context.close();
  });

  test("footer links exist on /login but not on /gate", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Terms" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy" })).toBeVisible();

    await page.goto("/gate");
    await expect(page.getByRole("link", { name: "Terms" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Privacy" })).toHaveCount(0);

    await context.close();
  });
});

/* =========================================================== 5  OPS */

test.describe("ops", () => {
  test("a server error lands in ops_errors sanitized: no query string, no body, scrubbed message", async ({
    baseURL,
    browser,
  }) => {
    // dev-boom throws only outside production builds; the dev server the
    // suites run against qualifies. Middleware wants a session cookie, so
    // sign in first.
    const context = await browser.newContext();
    const page = await context.newPage();
    await logIn(page, THIRD, DEMO_PASSWORD);

    const res = await page.request.post(
      `${baseURL}/api/dev-boom?leak=${QUERY_MARKER}`,
      { data: { note: BODY_MARKER } },
    );
    expect(res.status()).toBe(500);
    await context.close();

    // Capture is asynchronous; give instrumentation a moment.
    let row: Record<string, string> | undefined;
    await expect
      .poll(
        async () => {
          const rows = await opsErrorRows();
          row = rows.find((r) => r.route === "/api/dev-boom");
          return row ? "captured" : "missing";
        },
        { timeout: 15_000 },
      )
      .toBe("captured");

    expect(row!.route).toBe("/api/dev-boom"); // pathname only
    expect(row!.route).not.toContain("?");
    expect(row!.message).toContain("dev-boom");
    // The thrown message quoted an email and a phone number; the stored row
    // must hold neither, only the redaction marks.
    expect(row!.message).toContain("[redacted]");
    const rows = await opsErrorRows();
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(QUERY_MARKER);
    expect(everything).not.toContain(BODY_MARKER);
    expect(everything).not.toContain("boom-victim@example.net");
    expect(everything).not.toContain("415 555 0199");
  });

  test("GET /api/admin/errors serves the operator and denies a non-operator", async ({
    browser,
  }) => {
    const opContext = await browser.newContext();
    const opPage = await opContext.newPage();
    await logIn(opPage, OPERATOR, DEMO_PASSWORD);
    const ok = await opPage.request.get("/api/admin/errors");
    expect(ok.status()).toBe(200);
    const json = (await ok.json()) as { errors: { route: string }[] };
    expect(json.errors.some((e) => e.route === "/api/dev-boom")).toBe(true);
    await opContext.close();

    const thirdContext = await browser.newContext();
    const thirdPage = await thirdContext.newPage();
    await logIn(thirdPage, THIRD, DEMO_PASSWORD);
    const denied = await thirdPage.request.get("/api/admin/errors");
    expect(denied.status()).toBe(404); // the same status a wrong URL gets
    expect(await denied.json()).toEqual({ error: "Not found." });
    await thirdContext.close();
  });

  test("backup then restore round-trips the local database with identical table counts", async () => {
    test.setTimeout(120_000);
    const dumpPath = path.join(ROOT, "data", "hardening-backup.json.gz");
    const restorePath = path.join(ROOT, "data", "hardening-restore.db");
    await fs.rm(dumpPath, { force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rm(restorePath + suffix, { force: true });
    }

    const env = { ...process.env };
    delete env.TURSO_DATABASE_URL; // scripts must stay on the local file
    delete env.TURSO_AUTH_TOKEN;
    delete env.BLIND_TENDER_DB;

    execFileSync("npm", ["run", "backup", "--", "--out", dumpPath], {
      cwd: ROOT,
      env,
      stdio: "pipe",
    });
    execFileSync("npm", ["run", "restore", "--", dumpPath], {
      cwd: ROOT,
      env: { ...env, BLIND_TENDER_DB: `file:${restorePath}` },
      stdio: "pipe",
    });

    const live = await tableCounts(DB_PATH);
    const restored = await tableCounts(restorePath);
    expect([...restored.keys()].sort()).toEqual([...live.keys()].sort());
    for (const [table, n] of live) {
      expect(restored.get(table), `row count of ${table}`).toBe(n);
    }
    // The round trip walked real rows: an empty database would also "match".
    expect(live.get("users") ?? 0).toBeGreaterThan(0);
    expect(live.get("asks") ?? 0).toBeGreaterThan(0);
    expect(live.get("rate_limits") ?? 0).toBeGreaterThan(0);
    expect(live.get("ops_errors") ?? 0).toBeGreaterThan(0);
  });
});

/* ==================================================== 6  PRIVACY SWEEP */

test.describe("privacy regression over the hardening tables", () => {
  test("no raw IP, contact, or OTP code anywhere, the new tables included", async () => {
    const dump = await dumpDb();

    // The scan must actually be looking at the hardening tables.
    for (const table of ["rate_limits", "ops_errors", "operators", "hidden_asks"]) {
      expect(dump.tables, `dump covers ${table}`).toContain(table);
    }

    // Everything this spec typed into the auth surfaces, plus the synthetic
    // client IPs every hammered request carried. None of it may persist in
    // any column of any table.
    const markers = [
      HAMMER_CONTACT_A,
      HAMMER_CONTACT_B,
      CONTROL_CONTACT,
      OTP_CONTACT,
      NO_PROVIDER_EMAIL,
      NO_PROVIDER_PHONE,
      "4155550123", // NO_PROVIDER_PHONE normalized
      XFF_OTP,
      XFF_LOGIN,
      XFF_CONTROL,
      QUERY_MARKER,
      BODY_MARKER,
    ];
    for (const marker of markers) {
      expect(scanDump(dump, marker), `"${marker}" persisted`).toEqual([]);
    }

    // The OTP codes minted by the capture server. A specific six-digit run
    // colliding by chance inside a hex or base64 blob is ~1e-5 per code;
    // a plaintext code would hit every time.
    expect(capturedCodes.length).toBeGreaterThan(0);
    for (const code of capturedCodes) {
      expect(scanDump(dump, code), `OTP code ${code} persisted`).toEqual([]);
    }

    // Raw bytes, WAL included: even a deleted row would still show here.
    const raw = await rawDbBytes();
    for (const marker of markers) {
      expect(raw.includes(marker), `"${marker}" in raw db bytes`).toBe(false);
    }
  });

  test("rate_limits holds only HMAC buckets; ops_errors routes carry no query strings", async () => {
    const client = createClient({ url: `file:${DB_PATH}` });
    const cols = await client.execute(`PRAGMA table_info(rate_limits)`);
    expect(cols.rows.map((r) => String(r.name)).sort()).toEqual([
      "bucket",
      "count",
      "window_start",
    ]);
    const buckets = await client.execute(`SELECT bucket FROM rate_limits`);
    expect(buckets.rows.length).toBeGreaterThan(0);
    for (const row of buckets.rows) {
      expect(String(row.bucket)).toMatch(/^[0-9a-f]{64}$/);
    }
    const routes = await client.execute(`SELECT route FROM ops_errors`);
    for (const row of routes.rows) {
      expect(String(row.route)).not.toContain("?");
      expect(String(row.route)).not.toContain("#");
    }
    client.close();
  });
});
