/**
 * tests/responsive.spec.ts
 *
 * Hard responsive assertions, kept for the future:
 *
 *   1. /gate is a single hero: no vertical scrolling at 1440x900 or 1280x800.
 *   2. Every route (public and member, list and detail) fits 390x844 with no
 *      body-level horizontal scroll.
 *   3. The 390px nav carries every member route link, visible and clickable.
 *   4. Member routes, detail routes included, also fit 768x1024 with no
 *      body-level horizontal scroll (regression guard for the
 *      desktop-nav-too-wide-at-md defect).
 *   5. The /new and /deals/new submit footers stack at 390px: the submit
 *      button renders full-width on a single line (regression guard for the
 *      three-line squeezed-button defect).
 *
 * Each 390px route pass also refreshes the design-review screenshots under
 * verify/design/after/, plus /gate at 1440x900.
 *
 * PRECONDITION: freshly reset + seeded database, dev server on port 3949
 * started AFTER the reset:
 *
 *   npm run reset-db && npm run seed
 *   npx next dev --port 3949
 *   npx playwright test -c playwright.responsive.config.ts
 *
 * Read-mostly: signs in as the seeded quiet-ledger account and never posts,
 * confirms, or messages, so it can re-run against the same seed. Detail-route
 * ids (/ask/[id], /messages/[id], /deals/[id]) are discovered by walking the
 * real list pages, exactly as a user would reach them.
 */

import { test, expect, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const AFTER_DIR = path.join(ROOT, "verify", "design", "after");

const DEMO = { username: "quiet-ledger", password: "demo-demo-demo" };

/** Public routes, reachable (and measured) without a session. */
const PUBLIC_ROUTES = [
  "/gate",
  "/login",
  "/signup",
  "/transparency",
  "/transparency/verification",
] as const;

/** Member list/form routes; detail routes are discovered from these. */
const MEMBER_ROUTES = [
  "/",
  "/new",
  "/matches",
  "/messages",
  "/deals",
  "/deals/new",
  "/leaderboard",
  "/invites",
] as const;

/** The nav links a signed-in member must be able to reach at 390px. */
const NAV_LINKS = [
  { href: "/", label: "Board" },
  { href: "/new", label: "Post an ask" },
  { href: "/matches", label: "Matches" },
  { href: "/messages", label: "Messages" },
  { href: "/deals", label: "Deals" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/invites", label: "Invites" },
  { href: "/transparency", label: "Transparency" },
] as const;

test.beforeAll(async () => {
  await fs.mkdir(AFTER_DIR, { recursive: true });
});

/* ---------------------------------------------------------------- helpers */

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Handle").fill(DEMO.username);
  await page.getByLabel("Password").fill(DEMO.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(
    (url) => url.pathname === "/" || url.pathname === "",
    { timeout: 15_000 },
  );
}

/** scrollWidth vs innerWidth on the root element: the page body itself must
 *  never scroll horizontally (inner containers may). */
async function expectNoBodyHScroll(page: Page, route: string) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  expect(
    m.sw,
    `${route}: document.documentElement.scrollWidth ${m.sw} exceeds innerWidth ${m.iw}`,
  ).toBeLessThanOrEqual(m.iw);
}

async function gotoSettled(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("networkidle");
}

function slug(route: string): string {
  if (route === "/") return "board";
  if (route === "/gate") return "gate";
  return route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-");
}

/** First href on the page matching `prefix`, excluding exact `exclude`. */
async function firstDetailHref(
  page: Page,
  listRoute: string,
  prefix: string,
  exclude?: string,
): Promise<string> {
  await gotoSettled(page, listRoute);
  const hrefs = await page
    .locator(`a[href^="${prefix}"]`)
    .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  const found = hrefs.find((h) => h && h !== exclude);
  expect(
    found,
    `${listRoute} should link at least one ${prefix} detail page (seeded DB expected)`,
  ).toBeTruthy();
  return found!;
}

/* ----------------------------------------- 1. /gate is a single viewport */

for (const vp of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test.describe(`gate hero at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test(`no vertical scroll at ${vp.width}x${vp.height}`, async ({ page }) => {
      await gotoSettled(page, "/gate");
      if (vp.width === 1440) {
        await page.screenshot({
          path: path.join(AFTER_DIR, "gate-1440x900.png"),
        });
      }
      const m = await page.evaluate(() => ({
        sh: document.documentElement.scrollHeight,
        ih: window.innerHeight,
      }));
      expect(
        m.sh,
        `/gate: scrollHeight ${m.sh} exceeds innerHeight ${m.ih} at ${vp.width}x${vp.height}`,
      ).toBeLessThanOrEqual(m.ih);
      await expectNoBodyHScroll(page, "/gate");
    });
  });
}

/* --------------------------------- 2. every route fits 390x844, no h-scroll */

test.describe("mobile 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("public routes: no horizontal scroll", async ({ page }) => {
    for (const route of PUBLIC_ROUTES) {
      await gotoSettled(page, route);
      await page.screenshot({
        path: path.join(AFTER_DIR, `mobile-${slug(route)}.png`),
        fullPage: true,
      });
      await expectNoBodyHScroll(page, route);
    }
  });

  test("member routes, list and detail: no horizontal scroll", async ({
    page,
  }) => {
    await signIn(page);

    for (const route of MEMBER_ROUTES) {
      await gotoSettled(page, route);
      await page.screenshot({
        path: path.join(AFTER_DIR, `mobile-${slug(route)}.png`),
        fullPage: true,
      });
      await expectNoBodyHScroll(page, route);
    }

    // Detail routes, discovered from the seeded lists like a user would.
    const askHref = await firstDetailHref(page, "/", "/ask/");
    const threadHref = await firstDetailHref(page, "/messages", "/messages/");
    const dealHref = await firstDetailHref(
      page,
      "/deals",
      "/deals/",
      "/deals/new",
    );

    for (const [route, name] of [
      [askHref, "ask-detail"],
      [threadHref, "messages-thread"],
      [dealHref, "deal-detail"],
    ] as const) {
      await gotoSettled(page, route);
      await page.screenshot({
        path: path.join(AFTER_DIR, `mobile-${name}.png`),
        fullPage: true,
      });
      await expectNoBodyHScroll(page, route);
    }
  });

  /* ------------- 2b. submit footers stack: full-width single-line button */

  test("submit buttons on /new and /deals/new: one line, full width", async ({
    page,
  }) => {
    await signIn(page);

    for (const [route, label] of [
      ["/new", "Post to the board"],
      ["/deals/new", "Record the deal"],
    ] as const) {
      await gotoSettled(page, route);
      const button = page.getByRole("button", { name: label });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${route}: "${label}" button should have a bounding box`).toBeTruthy();
      // Single line: a wrapped label doubles (or triples) the height. One
      // line of 0.8125rem text plus py-2.5 padding stays well under 50px.
      expect(
        box!.height,
        `${route}: "${label}" button is ${box!.height}px tall - label is wrapping`,
      ).toBeLessThan(50);
      // Full width on mobile (w-full inside the px-5 page gutter).
      expect(
        box!.width,
        `${route}: "${label}" button is only ${box!.width}px wide - not full-width`,
      ).toBeGreaterThan(300);
    }
  });

  /* ------------------------- 3. nav at 390: every link present, clickable */

  test("nav strip: every member link present and clickable", async ({
    page,
  }) => {
    await signIn(page);
    await gotoSettled(page, "/");

    for (const link of NAV_LINKS) {
      // Two navs render (desktop, hidden; mobile strip, visible). Assert on
      // the visible one, whatever breakpoint implements it.
      const visible = page
        .locator(`header nav a[href="${link.href}"]`)
        .locator("visible=true")
        .first();
      await expect(
        visible,
        `nav link "${link.label}" (${link.href}) should be visible at 390px`,
      ).toBeVisible();
      await expect(visible).toContainText(link.label);
      await visible.click();
      await page.waitForURL((url) => url.pathname === link.href, {
        timeout: 15_000,
      });
    }
  });
});

/* ------------------------------ 4. member routes fit 768x1024, no h-scroll */

test.describe("tablet 768x1024", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("member routes: no horizontal scroll", async ({ page }) => {
    await signIn(page);
    // Board first, with evidence screenshot: this viewport is where the
    // desktop nav switches on, and the header must fit when it does.
    await gotoSettled(page, "/");
    await page.screenshot({
      path: path.join(AFTER_DIR, "tablet-board-768x1024.png"),
    });
    await expectNoBodyHScroll(page, "/");

    for (const route of MEMBER_ROUTES.slice(1)) {
      await gotoSettled(page, route);
      await expectNoBodyHScroll(page, route);
    }
    for (const route of ["/transparency", "/transparency/verification"]) {
      await gotoSettled(page, route);
      await expectNoBodyHScroll(page, route);
    }

    // Detail routes too: the md-width overflow hit every signed-in page,
    // detail pages included, so they get their own guard.
    const askHref = await firstDetailHref(page, "/", "/ask/");
    const threadHref = await firstDetailHref(page, "/messages", "/messages/");
    const dealHref = await firstDetailHref(
      page,
      "/deals",
      "/deals/",
      "/deals/new",
    );
    for (const route of [askHref, threadHref, dealHref]) {
      await gotoSettled(page, route);
      await expectNoBodyHScroll(page, route);
    }
  });
});
