import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initializeSchema } from './schema';
import { isDbQuiesceActive } from '../maintenance/state';

export const DB_PATH = process.env.RAID_TRACKER_DB_PATH
    ? path.resolve(process.env.RAID_TRACKER_DB_PATH)
    : path.join(process.cwd(), 'data', 'raid-tracker.db');

// Next.js production builds can instantiate this module once per server entrypoint
// (instrumentation, each route bundle), so a bare module-level singleton yields one
// connection — and one 64 MB page cache — per copy. That's the repeated
// "database initialized" log at startup. Stash the handle on globalThis (same
// pattern as swr-cache.ts) so every copy shares a single connection per process.
const GLOBAL_DB_KEY = '__destinyFarmFinderDb__';

function getGlobalDbRef(): { instance: Database.Database | null } {
    const g = globalThis as unknown as Record<string, { instance: Database.Database | null } | undefined>;
    if (!g[GLOBAL_DB_KEY]) {
        g[GLOBAL_DB_KEY] = { instance: null };
    }
    return g[GLOBAL_DB_KEY]!;
}

export class DatabaseMaintenanceError extends Error {
    constructor(message: string = 'Database maintenance is in progress') {
        super(message);
        this.name = 'DatabaseMaintenanceError';
    }
}

function busyTimeoutMs(): number {
    const raw = process.env.SQLITE_BUSY_TIMEOUT_MS;
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30000;
}

function configureDatabase(db: Database.Database): void {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('foreign_keys = ON');
    // Queue behind a competing process's write lock instead of throwing
    // SQLITE_BUSY after better-sqlite3's 5s default. The wait is synchronous:
    // the calling process's event loop blocks until the lock frees or the
    // timeout expires.
    db.pragma(`busy_timeout = ${busyTimeoutMs()}`);
    // Truncate the WAL file back to 64 MB when a checkpoint resets it. Without a
    // limit SQLite reuses the file but never shrinks it, so one write burst
    // (e.g. a backlog cleanup churning scattered index pages) pins its GB-scale
    // high-water mark on disk as dead space indefinitely.
    db.pragma('journal_size_limit = 67108864');
}

export function isDatabaseMaintenanceError(error: unknown): error is DatabaseMaintenanceError {
    // Also match by name: with per-entrypoint module copies (see GLOBAL_DB_KEY note),
    // an error thrown by one copy's class fails `instanceof` against another copy's.
    return error instanceof DatabaseMaintenanceError
        || (error instanceof Error && error.name === 'DatabaseMaintenanceError');
}

/**
 * Refuses to open anything but a throwaway database while running under a test
 * runner — Vitest (VITEST) or the Playwright e2e suite (DFF_E2E).
 *
 * DB_PATH above is resolved at *import* time, so whichever import comes first
 * freezes it for the process. Tests win that race only because
 * tests/setup/test-db-path.ts runs as a Vitest setupFile, ahead of any test
 * file's imports. If that ordering is ever broken — setupFiles reordered, the
 * setup file turned into a helper, a config without setupFiles — DB_PATH
 * silently becomes the real database and the suite's DELETE/VACUUM paths operate
 * on live data. Nothing would error. This turns that into a hard failure.
 *
 * The e2e suite mints its own path in e2e/support/fixture-db.ts and sets both
 * env vars, because tests/setup/test-db-path.ts imports from `vitest` and cannot
 * be reused. Two processes must receive them there — the seeder and the
 * `next start` child — so this check alone is not sufficient for e2e: it is
 * opt-in by env, and cannot fire if the env never arrives. That gap is closed
 * separately by a fail-fast in playwright.config.ts and by the canary check in
 * e2e/support/canary.setup.ts, which observes which database the running server
 * actually opened. See docs/adr/0003.
 *
 * Yes, this means src/ contains a branch that only exists for tests, which is
 * the sort of thing ADR 0004 is otherwise suspicious of. It is a precondition
 * check, not a mock: it substitutes no behaviour, so it cannot make a failing
 * test pass — its only effect is aborting a run whose configuration is already
 * wrong. Rails' ProtectedEnvironmentError makes the same trade. Please don't
 * delete it as a smell; see docs/adr/0003 and 0004.
 */
function assertDbPathAllowed(): void {
    const runner = process.env.VITEST ? 'Vitest' : process.env.DFF_E2E ? 'the e2e suite' : null;
    if (!runner) return;

    const allowed = process.env.DFF_TEST_DB_SENTINEL;
    if (!allowed || DB_PATH !== path.resolve(allowed)) {
        throw new Error(
            `Refusing to open ${DB_PATH} under ${runner} — it is not the throwaway database ` +
            `named by DFF_TEST_DB_SENTINEL. Either the setup that mints it did not run, or ` +
            `something imported src/lib/db before it did.`
        );
    }
}

export function getDb(): Database.Database {
    assertDbPathAllowed();

    if (isDbQuiesceActive()) {
        closeDb();
        throw new DatabaseMaintenanceError();
    }

    const ref = getGlobalDbRef();
    if (!ref.instance) {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

        const db = new Database(DB_PATH);

        configureDatabase(db);

        initializeSchema(db);

        ref.instance = db;
        console.log(`📂 SQLite database initialized at ${DB_PATH}`);
    }
    return ref.instance;
}

export function closeDb(): void {
    const ref = getGlobalDbRef();
    if (ref.instance) {
        ref.instance.close();
        ref.instance = null;
        console.log('📂 SQLite database closed');
    }
}

export function openMaintenanceDb(): Database.Database {
    // Deliberately NOT behind assertDbPathAllowed(): nothing in the test suite
    // reaches this today. If you write a test that does, add the call — this
    // opens a raw connection and its callers VACUUM through it.
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH);
    configureDatabase(db);
    return db;
}
