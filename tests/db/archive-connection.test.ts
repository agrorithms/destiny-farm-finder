import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFixtureArchive } from '../helpers/archive-seed';
import {
    ARCHIVE_DB_PATH,
    closeArchiveDb,
    getArchiveDb,
    isArchiveUnavailableError,
    verifyArchiveRowCounts,
} from '@/lib/db/archive';

/**
 * The Archive is a build artifact deployed by hand: two scp steps that no CI check
 * enforces (ADR 0007). These are the two failures that would otherwise be silent — a
 * file that is not there, and a file that is the wrong one — and the row-count check is
 * what stands in for the build-time failure that dynamic rendering gave up.
 *
 * verifyArchiveRowCounts() is exercised directly rather than through getArchiveDb(),
 * which skips it for the fixture: the fixture is a nine-run sample and cannot satisfy
 * production counts by construction.
 */

beforeEach(() => {
    closeArchiveDb();
    buildFixtureArchive();
});

afterEach(() => {
    closeArchiveDb();
});

describe('the Archive connection', () => {
    it('opens the throwaway fixture, not the real database', () => {
        expect(ARCHIVE_DB_PATH).toBe(process.env.DFF_TEST_GOS10K_DB_SENTINEL);
        expect(getArchiveDb().name).toBe(ARCHIVE_DB_PATH);
    });

    it('refuses to write, because the data is frozen', () => {
        expect(() => getArchiveDb().exec('DELETE FROM gos_10k_runs')).toThrow(/readonly/i);
    });

    it('says the file is missing rather than creating an empty one', () => {
        // The disaster scenario is not an error, it is a page that renders "0 runs"
        // off a database SQLite helpfully created. fileMustExist plus this check make
        // a forgotten scp loud.
        closeArchiveDb();
        fs.rmSync(ARCHIVE_DB_PATH);

        expect(() => getArchiveDb()).toThrow(/No Archive database/);
        expect(fs.existsSync(ARCHIVE_DB_PATH)).toBe(false);
    });
});

describe('the manifest row-count check', () => {
    function openFixture(): Database.Database {
        return new Database(ARCHIVE_DB_PATH, { readonly: true, fileMustExist: true });
    }

    it('passes when the file matches what was built', () => {
        const db = openFixture();
        expect(() =>
            verifyArchiveRowCounts(db, { gos_10k_runs: 9 }, ARCHIVE_DB_PATH)
        ).not.toThrow();
        db.close();
    });

    it('names the table and both counts when a stale copy is short', () => {
        // What a truncated or pre-2026-09-03 scp actually looks like: every query still
        // works, every number is plausible, and the total is wrong.
        const db = openFixture();
        try {
            verifyArchiveRowCounts(db, { gos_10k_runs: 13420 }, ARCHIVE_DB_PATH);
            expect.unreachable('expected the mismatch to throw');
        } catch (error) {
            expect(isArchiveUnavailableError(error)).toBe(true);
            expect((error as Error).message).toContain('gos_10k_runs: expected 13420, found 9');
            expect((error as Error).message).toContain('npm run build-gos10k');
        }
        db.close();
    });

    it('reports a missing table rather than throwing a SQL error', () => {
        const db = openFixture();
        expect(() => verifyArchiveRowCounts(db, { gos_10k_nonexistent: 1 }, ARCHIVE_DB_PATH))
            .toThrow(/gos_10k_nonexistent: table is missing/);
        db.close();
    });
});
