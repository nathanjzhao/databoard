import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the deals + leaderboard spec (tests/deals.spec.ts).
 *
 * Unlike playwright.config.ts this one does NOT manage a webServer: the spec
 * is run against a dev server the operator starts on port 3948 AFTER a fresh
 * reset + seed, so the server and the sqlite file agree from the first query:
 *
 *   npm run reset-db && npm run seed
 *   npx next dev --port 3948        # started after the reset, kept running
 *   npx playwright test -c playwright.deals.config.ts
 *
 * Serial, one worker, no retries, for the same reason as the flow spec: the
 * tests share accounts, deals, and leaderboard state, and a retry against a
 * half-mutated ledger would lie.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /deals\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3948",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
