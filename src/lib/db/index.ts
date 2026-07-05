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
}

export function isDatabaseMaintenanceError(error: unknown): error is DatabaseMaintenanceError {
    // Also match by name: with per-entrypoint module copies (see GLOBAL_DB_KEY note),
    // an error thrown by one copy's class fails `instanceof` against another copy's.
    return error instanceof DatabaseMaintenanceError
        || (error instanceof Error && error.name === 'DatabaseMaintenanceError');
}

export function getDb(): Database.Database {
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
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH);
    configureDatabase(db);
    return db;
}
