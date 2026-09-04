import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { assertDbPathAllowed } from '../index';
import manifest from './gos-10k-manifest.json';

/**
 * The GoS 10k Archive: a frozen, complete, read-only historical dataset, served
 * alongside the Tracker and never joined to it. See ADR 0007 and CONTEXT.md.
 *
 * Mirrors ../index.ts with four deliberate differences, each of which is the point
 * rather than an omission:
 *
 *   1. `readonly` AND `fileMustExist`. The data is finished; nothing here writes.
 *      `fileMustExist` is the load-bearing half — without it SQLite happily creates
 *      an empty database and the page renders "0 runs", which looks like an answer.
 *   2. No initializeSchema(). That function is the *Tracker's* schema; running it
 *      here would add a dozen foreign tables to an archive.
 *   3. A small cache_size, not the Tracker's -64000. PM2 runs `web` in cluster mode
 *      at instances: 2 on a 12 GB box, so every pragma is paid twice — and the whole
 *      serving file is smaller than the Tracker's cache setting.
 *   4. Row counts verified against a committed manifest on first open.
 */

export const ARCHIVE_DB_PATH = process.env.GOS10K_ARCHIVE_DB_PATH
    ? path.resolve(process.env.GOS10K_ARCHIVE_DB_PATH)
    : path.join(process.cwd(), 'data', 'gos-10k.db');

// Same per-entrypoint module-copy reason as the Tracker's GLOBAL_DB_KEY: a Next
// production build instantiates this module once per server entrypoint, so a bare
// module-level singleton is one connection per copy rather than one per process.
const GLOBAL_ARCHIVE_DB_KEY = '__destinyFarmFinderArchiveDb__';

function getGlobalArchiveDbRef(): { instance: Database.Database | null } {
    const g = globalThis as unknown as Record<string, { instance: Database.Database | null } | undefined>;
    if (!g[GLOBAL_ARCHIVE_DB_KEY]) {
        g[GLOBAL_ARCHIVE_DB_KEY] = { instance: null };
    }
    return g[GLOBAL_ARCHIVE_DB_KEY]!;
}

export class ArchiveUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ArchiveUnavailableError';
    }
}

export function isArchiveUnavailableError(error: unknown): error is ArchiveUnavailableError {
    // By name as well as by class: with per-entrypoint module copies, an error thrown
    // by one copy's class fails `instanceof` against another copy's.
    return error instanceof ArchiveUnavailableError
        || (error instanceof Error && error.name === 'ArchiveUnavailableError');
}

/**
 * Checks the opened file against the manifest that shipped in the source tree.
 *
 * This is what stands in for the build-time failure that dynamic rendering gave up
 * (ADR 0007). Deployment is two manual `scp`s; nothing in CI can notice a forgotten,
 * truncated or stale one. Comparing row counts turns "serving a plausible wrong
 * number" into a loud error on one route.
 *
 * Row counts rather than a whole-file checksum on purpose: hashing 63 MB on every
 * cold process start buys precision over a failure mode — corruption that preserves
 * every table's row count exactly — that no plausible operator mistake produces. The
 * sha256 is in the manifest for a human to check after a copy; this is what the
 * process checks for itself.
 *
 * Exported so it can be tested directly against real files, which is the only way to
 * test it: getArchiveDb() skips it for the throwaway fixture (see below).
 */
export function verifyArchiveRowCounts(
    db: Database.Database,
    expected: Record<string, number>,
    dbPath: string
): void {
    const mismatches: string[] = [];

    for (const [table, expectedRows] of Object.entries(expected)) {
        let actual: number;
        try {
            actual = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        } catch {
            mismatches.push(`${table}: table is missing`);
            continue;
        }
        if (actual !== expectedRows) {
            mismatches.push(`${table}: expected ${expectedRows}, found ${actual}`);
        }
    }

    if (mismatches.length > 0) {
        throw new ArchiveUnavailableError(
            `The Archive at ${dbPath} does not match the manifest committed at ` +
            `src/lib/db/archive/gos-10k-manifest.json (built ${manifest.builtAt}): ` +
            `${mismatches.join('; ')}. The file on disk is stale, truncated or from a ` +
            `different build — rebuild with \`npm run build-gos10k\` and re-copy it. ` +
            `See docs/decisions.md.`
        );
    }
}

/**
 * Opens the Archive, verifying it once per process.
 *
 * **Throws on first access, not at module load.** A forgotten scp is an operator
 * error on one bolt-on page, not a reason to stop serving leaderboards; throwing
 * from instrumentation or at import would turn it into a full-site outage. The
 * /gos10k route 500s and the rest of the site is untouched. Rejected alternative:
 * a null handle plus an "unavailable" state, which at a glance is indistinguishable
 * from a page that legitimately has no data.
 */
export function getArchiveDb(): Database.Database {
    assertDbPathAllowed(ARCHIVE_DB_PATH, 'DFF_TEST_GOS10K_DB_SENTINEL', 'GoS 10k Archive');

    const ref = getGlobalArchiveDbRef();
    if (ref.instance) return ref.instance;

    if (!fs.existsSync(ARCHIVE_DB_PATH)) {
        throw new ArchiveUnavailableError(
            `No Archive database at ${ARCHIVE_DB_PATH}. It is a build artifact, not a crawl ` +
            `target: build it with \`npm run build-gos10k\` from the master under gos10k/, or ` +
            `copy it to the box. Set GOS10K_ARCHIVE_DB_PATH to point elsewhere.`
        );
    }

    const db = new Database(ARCHIVE_DB_PATH, { readonly: true, fileMustExist: true });
    // 8 MB. The whole file is 63 MB and nothing here writes, so the Tracker's 64 MB
    // is wasted twice over under PM2 cluster mode.
    db.pragma('cache_size = -8000');

    // The fixture Archive is a deliberate sample of the real one — a few dozen rows
    // chosen for their hazards — so it cannot satisfy production row counts and is
    // not meant to. The guard above has already proved this path is the throwaway
    // fixture, so skipping here cannot silence the check for a real file.
    // verifyArchiveRowCounts() is tested directly instead.
    const isFixture = Boolean((process.env.VITEST || process.env.DFF_E2E) && process.env.DFF_TEST_GOS10K_DB_SENTINEL);
    if (!isFixture) {
        try {
            verifyArchiveRowCounts(db, manifest.rowCounts, ARCHIVE_DB_PATH);
        } catch (error) {
            db.close();
            throw error;
        }
    }

    ref.instance = db;
    console.log(`📚 GoS 10k Archive opened (read-only) at ${ARCHIVE_DB_PATH}`);
    return db;
}

export function closeArchiveDb(): void {
    const ref = getGlobalArchiveDbRef();
    if (ref.instance) {
        ref.instance.close();
        ref.instance = null;
    }
}
