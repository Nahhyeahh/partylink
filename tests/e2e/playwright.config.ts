import { defineConfig, devices } from "@playwright/test";

// Runs the built web app and the real server locally under `wrangler dev`,
// then drives several real browser windows against it.
// Build the web app first: `pnpm build`.
const PORT = 8788;

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @partylink/server exec wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to .wrangler/e2e-state`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
