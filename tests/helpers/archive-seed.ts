import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import seedJson from '../fixtures/archive-seed.json';

/**
 * Builds the fixture Archive from the committed seed.
 *
 * The Archive is a frozen artifact in production — a file copied into place, never
 * written by the app — so there is nothing to seed at runtime the way the Tracker's
 * helpers seed rows. The fixture is instead *built once per test file* into the
 * throwaway path minted by tests/setup/test-db-path.ts, then opened read-only by the
 * same getArchiveDb() production uses.
 *
 * The rows and the schema both come from tests/fixtures/archive-seed.json, extracted
 * from the real master by scripts/extract-archive-fixture.ts. They are real rows chosen
 * for their hazards — read `targets` in that file for what each one is for.
 *
 * Lives in tests/helpers/ and therefore, per CLAUDE.md: no import from `vitest`
 * (Playwright loads this directory too and has no `vi`), and relative imports only
 * (Playwright's loader does not apply tsconfig `paths` to globalSetup).
 */

interface ArchiveSeed {
    generatedAt: string;
    source: string;
    pinInstanceId: string;
    targets: Array<{ instanceId: string; why: string }>;
    schema: string[];
    tables: Record<string, Array<Record<string, unknown>>>;
}

// Imported rather than read from disk, like the nine PGCR fixtures beside it: both
// runners resolve a JSON import, and neither has to agree on a working directory.
export function readArchiveSeed(): ArchiveSeed {
    return seedJson as unknown as ArchiveSeed;
}

/**
 * Writes the fixture Archive to `dbPath`, replacing anything already there.
 *
 * Defaults to GOS10K_ARCHIVE_DB_PATH — the path getArchiveDb() will open, and the only
 * path its guard permits under a test runner. Call this before the first getArchiveDb()
 * of a file: the connection is a per-process singleton, so rebuilding the file
 * underneath an open handle would leave the old snapshot in memory.
 */
export function buildFixtureArchive(dbPath: string = process.env.GOS10K_ARCHIVE_DB_PATH ?? ''): string {
    if (!dbPath) {
        throw new Error(
            'GOS10K_ARCHIVE_DB_PATH is unset. tests/setup/test-db-path.ts mints it; if you are ' +
            'calling this from a runner without that setup file, pass a path explicitly.'
        );
    }

    for (const suffix of ['', '-wal', '-shm']) {
        const stale = `${dbPath}${suffix}`;
        if (fs.existsSync(stale)) fs.rmSync(stale);
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const seed = readArchiveSeed();
    const db = new Database(dbPath);

    // The schema is the master's own DDL, captured at extract time, so the fixture
    // cannot drift from the database the queries actually run against in production.
    for (const statement of seed.schema) {
        db.exec(statement);
    }

    for (const [table, rows] of Object.entries(seed.tables)) {
        if (rows.length === 0) continue;
        const columns = Object.keys(rows[0]);
        const insert = db.prepare(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        );
        const insertAll = db.transaction((batch: Array<Record<string, unknown>>) => {
            for (const row of batch) {
                insert.run(columns.map((column) => row[column] as null));
            }
        });
        insertAll(rows);
    }

    db.close();
    return dbPath;
}
