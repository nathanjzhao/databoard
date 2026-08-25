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
 *
 * PW_PORT overrides the port (default 3947) when a dev server is already
 * running elsewhere; webServer reuses it instead of starting a second one.
 */
// A production env file would be loaded by the `next start` webServer and
// point every suite at the production database. That happened once; the
// cleanup was not fun. Refuse to run while one exists.
import { existsSync } from "node:fs";
for (const f of [".env.production.local", ".env.production"]) {
  if (existsSync(f)) {
    throw new Error(
      `${f} exists; the test webServer would load it and drive production. ` +
        "Move it out of the repo before running the suites.",
    );
  }
}

const PORT = Number(process.env.PW_PORT ?? 3947);

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    // CI runs `npm run build` before the suites, so serve that build there:
    // per-request dev compiles on a cold shared runner blow the test timeout
    // (the recurring "signup took 1.5m" flake). Locally, dev stays the
    // default so the edit-test loop keeps hot reload.
    command: process.env.CI
      ? `npx next start --port ${PORT}`
      : PORT === 3947
        ? "npm run dev"
        : `npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/gate`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
