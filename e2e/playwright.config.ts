import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * desktop + mobile: the built SPA served by the real API on a throwaway PGlite (Postgres) database seeded with the
 * hand-labelled demo release (no API keys, no outbound model calls).
 * smoke: read-only checks against a deployed URL (SMOKE_URL), run after every deploy.
 */
const PORT = Number(process.env.E2E_PORT ?? 4319);
const BASE = `http://localhost:${PORT}`;
const PGLITE = join(tmpdir(), `pb-e2e-${PORT}-pglite`);
export const ADMIN_PASSWORD = "e2e-admin-password";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    // Signs in once and saves the session, so admin specs don't trip the login rate limiter.
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { baseURL: BASE } },
    { name: "desktop", testIgnore: /smoke\.spec\.ts|auth\.setup\.ts/, dependencies: ["setup"], use: { ...devices["Desktop Chrome"], baseURL: BASE } },
    { name: "mobile", testMatch: /(public|layout)\.spec\.ts/, use: { ...devices["Pixel 7"], baseURL: BASE } },
    { name: "smoke", testMatch: /smoke\.spec\.ts/, use: { baseURL: process.env.SMOKE_URL || "https://web-production-2e4ac.up.railway.app" } },
  ],
  webServer: process.argv.includes("--project=smoke")
    ? undefined
    : {
        // Builds and runs exactly what production runs: the bundled server under plain node (.railway/railway.ts), on
        // PGlite instead of a Postgres server. seed:e2e adds a finished, flagged, non-demo evaluation for
        // admin-flows.spec.ts; the server then adds the demo release.
        command: `rm -rf "${PGLITE}" && pnpm --dir .. --filter @pb/web build && pnpm --dir .. --filter @pb/server build && pnpm --dir .. --filter @pb/server seed:e2e && node --enable-source-maps ../apps/server/dist/index.js`,
        url: `${BASE}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        stdout: "ignore",
        stderr: "pipe",
        env: {
          NODE_ENV: "production",
          PORT: String(PORT),
          PUBLIC_URL: BASE,
          PGLITE_DIR: PGLITE,
          // No SQLite database to import.
          DB_PATH: join(tmpdir(), `pb-e2e-${PORT}-none.db`),
          DATABASE_URL: "",
          SEED_DEMO: "1",
          ADMIN_PASSWORD,
          SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
          ANTHROPIC_API_KEY: "",
          GITHUB_TOKEN: "",
          EXA_API_KEY: "",
          NEWSAPI_AI_KEY: "",
          X_BEARER_TOKEN: "",
          VERSION_CHECK_INTERVAL_HOURS: "0",
        },
      },
});
