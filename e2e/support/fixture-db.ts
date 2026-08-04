import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Mints the throwaway database the whole e2e run points at.
 *
 * This file must not import anything that reaches `src/lib/db`, directly or
 * transitively. `DB_PATH` in src/lib/db/index.ts is a module-level const
 * resolved at *import* time, so the env vars below have to be set before that
 * module is first loaded anywhere in the process. It is the same ordering
 * constraint tests/setup/test-db-path.ts solves for Vitest — that file can't be
 * reused because it imports `afterAll` from `vitest`. Seeding therefore lives in
 * ./seed-world.ts, which is loaded only after this has run.
 *
 * Called from playwright.config.ts at config load, which is the earliest point
 * the run controls and the only place that builds `webServer.env`.
 */

/** Env vars every process in the e2e run needs. Kept in one place so the config
 *  and the workers cannot drift on the list. */
export const FIXTURE_DB_ENV_KEYS = [
    'RAID_TRACKER_DB_PATH',
    'DFF_TEST_DB_SENTINEL',
    'DFF_E2E',
    'DFF_E2E_RUN_ID',
] as const;

/**
 * Idempotent by design. playwright.config.ts is re-loaded in every worker
 * process, and workers inherit the runner's env — so a second call must reuse
 * the already-minted path rather than creating a fresh directory that nothing
 * else knows about. Without this, workers would seed one database while the
 * server read another and every assertion would fail for a reason nowhere near
 * the test.
 */
export function mintFixtureDbPath(): string {
    const existing = process.env.RAID_TRACKER_DB_PATH;
    if (process.env.DFF_E2E && existing) {
        return path.resolve(existing);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dff-e2e-'));
    const dbPath = path.join(dir, 'e2e.db');

    process.env.RAID_TRACKER_DB_PATH = dbPath;
    // The one database any process in this run is allowed to open. getDb()
    // compares DB_PATH against it and refuses anything else while DFF_E2E is
    // set — see assertDbPathAllowed() in src/lib/db/index.ts.
    process.env.DFF_TEST_DB_SENTINEL = dbPath;
    process.env.DFF_E2E = '1';
    // Unique per run, and baked into the canary row. A server left over from an
    // earlier run would still hold a canary — just the *previous* run's — so
    // without this the canary check would pass while every spec silently read a
    // stale database. See canaryDisplayName() in ./seed-world.ts.
    process.env.DFF_E2E_RUN_ID = path.basename(dir).replace('dff-e2e-', '');

    return dbPath;
}

/** The nonce that ties the canary row to this specific run. */
export function fixtureRunId(): string {
    const runId = process.env.DFF_E2E_RUN_ID;
    if (!runId) {
        throw new Error('DFF_E2E_RUN_ID is unset — mintFixtureDbPath() did not run.');
    }
    return runId;
}

/**
 * The minted path, for code running after config load. Throws rather than
 * falling back, because a silent fallback here is the live 5.5 GB database.
 */
export function fixtureDbPath(): string {
    const dbPath = process.env.RAID_TRACKER_DB_PATH;
    if (!dbPath || !process.env.DFF_E2E) {
        throw new Error(
            'The e2e fixture database was never minted. mintFixtureDbPath() runs from ' +
            'playwright.config.ts at config load — if you are seeing this, that did not happen.'
        );
    }
    return path.resolve(dbPath);
}
