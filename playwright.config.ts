import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the end-to-end flow spec (tests/flow.spec.ts).
 *
 * The spec drives the real signup / post / match / message flow against a dev
 * server on port 3947 and expects a freshly reset database:
 *
 *   npm run reset-db && npm run seed
 *   npm run dev            # port 3947, or let webServer below start it
 *   npx playwright test
 *
 * Serial by construction: the tests share accounts and board state, so one
 * worker, no parallelism, no retries (a retry against a dirty DB would lie).
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3947",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3947/gate",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
