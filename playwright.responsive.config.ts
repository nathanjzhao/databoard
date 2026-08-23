import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the responsive spec (tests/responsive.spec.ts).
 *
 * Like the deals config it does NOT manage a webServer: the spec runs
 * against a dev server the operator starts on port 3949 AFTER a fresh
 * reset + seed (the spec signs in as the seeded quiet-ledger account and
 * walks every route, so the server and the sqlite file must agree):
 *
 *   npm run reset-db && npm run seed
 *   npx next dev --port 3949        # started after the reset, kept running
 *   npx playwright test -c playwright.responsive.config.ts
 *
 * One worker, no retries. The tests are read-mostly (they never post or
 * confirm anything) but they share the seeded accounts, and each test sets
 * its own viewport, so parallel workers would only add flake.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /responsive\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3949",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
