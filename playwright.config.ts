import { defineConfig, devices } from '@playwright/test';
import { E2E_PAGE_TOKEN_SECRET, FIXTURE_DB_ENV_KEYS, mintFixtureDbPath } from './e2e/support/fixture-db';
import { E2E_BASE_URL, E2E_PORT } from './e2e/support/server';

/**
 * Browser tests. Vitest owns `.test.ts`; this owns `.spec.ts` under e2e/, and
 * the two cannot see each other's files — `testDir` + `testMatch` here,
 * `include` + `exclude` in vitest.config.ts.
 *
 * Runs against a production build on port 3100, never `next dev`: React
 * StrictMode double-invokes effects in development, and both pages under test
 * fetch from `useEffect`, so a dev server would double every request and make
 * the leaderboard refetch assertion meaningless.
 */

// Mint before anything else. This sets RAID_TRACKER_DB_PATH, which src/lib/db
// freezes at import time, and it must therefore happen at config load — the
// earliest point this run controls. Idempotent: config is re-loaded in every
// worker, and workers inherit the runner's env.
const dbPath = mintFixtureDbPath();

// Also at config load, and in every worker: specs mint page tokens in the
// runner process and they have to be signed with the same secret the server is
// started with (set in webServer.env below). Unconditional — a developer's own
// PAGE_TOKEN_SECRET would otherwise survive into the worker and mint tokens the
// server rejects. See E2E_PAGE_TOKEN_SECRET.
process.env.PAGE_TOKEN_SECRET = E2E_PAGE_TOKEN_SECRET;

// Fail-fast, layer 2 of the fixture-database guard. If any of these is missing
// the `next start` child would fall back to the live database, and
// assertDbPathAllowed() cannot help because it is opt-in by env.
for (const key of FIXTURE_DB_ENV_KEYS) {
    if (!process.env[key]) {
        throw new Error(
            `Refusing to run e2e: ${key} was not set by mintFixtureDbPath(). ` +
            'Without it the app under test would open the live database.'
        );
    }
}

export default defineConfig({
    testDir: './e2e',
    // Vitest files are `.test.ts`. Restricting to `.spec.ts` means neither runner
    // can pick up the other's files even if a directory boundary is later moved.
    testMatch: '**/*.spec.ts',

    // Serial and single-worker on purpose. The client-write rate limiters in
    // src/lib/http/rate-limit.ts are per-process singletons in the server, so
    // parallel specs would see each other's cooldowns through state that no
    // database isolation can reach. Seconds of wall-clock for a whole class of
    // order-dependent flake. See the plan's D2.
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: !!process.env.CI,

    reporter: 'list',

    globalSetup: './e2e/support/global-setup.ts',

    use: {
        baseURL: E2E_BASE_URL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'off',
    },

    projects: [
        {
            // Proves the running server is on this run's fixture database before
            // any spec asserts anything. A project dependency rather than a step
            // inside globalSetup, so the ordering is guaranteed by Playwright
            // rather than by an assumption about when webServer boots.
            name: 'canary',
            testMatch: /canary\.setup\.ts$/,
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
            dependencies: ['canary'],
        },
    ],

    webServer: {
        // The build is NOT here — `npm run e2e` runs it first, in the shell, so
        // a build failure reads as a build failure rather than as a server that
        // failed to start, and so it stays under .claude/hooks/guard-build.sh.
        command: `npm run start -- -p ${E2E_PORT}`,
        url: E2E_BASE_URL,
        // Never reuse. A server left from an earlier run points at that run's
        // fixture database; the canary would then be checking the wrong one.
        // The canary's per-run nonce catches it anyway, but not starting a stale
        // server is simpler than detecting one.
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
            RAID_TRACKER_DB_PATH: dbPath,
            DFF_TEST_DB_SENTINEL: dbPath,
            DFF_E2E: '1',
            DFF_E2E_RUN_ID: process.env.DFF_E2E_RUN_ID!,

            // NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY is deliberately NOT set here, and
            // cannot usefully be: Next inlines NEXT_PUBLIC_* at *build* time, so a
            // value supplied to `next start` never reaches the client bundle. The
            // browser gets whatever was in .env when `next build` ran. Harmless
            // today — no baseline spec makes a browser → Bungie call, and
            // e2e/support/test-fixtures.ts stubs bungie.net regardless — but worth
            // knowing before writing a spec that depends on the key's value.

            // ACTIVE_SESSION_DISPLAY_LIMIT is deliberately NOT overridden here.
            // src/app/active-sessions/page.tsx requests `?limit=600` as a
            // hardcoded literal, and the route 400s when limit exceeds the
            // configured cap — so lowering it empties the page instead of
            // trimming it. active-sessions-cap.spec.ts proves the cap through the
            // API's own `limit` parameter instead. See the handoff.

            // Keeps e2e telemetry out of the production Sentry bucket. The DSN is
            // hardcoded in sentry.server.config.ts so it cannot be unset from
            // here; this makes what still ships filterable. Browser-side traffic
            // is stopped outright in e2e/support/test-fixtures.ts.
            SENTRY_ENVIRONMENT: 'e2e',

            // The server half of the pin. Explicit here because `next start`
            // loads .env, and only a value set in webServer.env overrides it for
            // the child. See E2E_PAGE_TOKEN_SECRET.
            PAGE_TOKEN_SECRET: E2E_PAGE_TOKEN_SECRET,
        },
    },
});
