import type Database from 'better-sqlite3';
import { getDb } from '../../src/lib/db';

/**
 * Access to the per-file test database.
 *
 * The database path is set by tests/setup/test-db-path.ts before this file's
 * imports run, so `getDb()` here opens a throwaway database in a temp directory
 * with the production schema already applied — initializeSchema() runs inside
 * getDb(), including the ended_at migration guard and the Phase 3 indexes. The
 * schema under test is therefore the production schema by construction rather
 * than a duplicated copy that can drift.
 */

export function testDb(): Database.Database {
    return getDb();
}

/**
 * Empties every table, leaving the schema intact. Call in beforeEach so tests
 * share one connection but never share rows — reopening the database per test
 * would re-run schema init for no benefit.
 *
 * Order respects the pgcr_players -> pgcrs foreign key.
 */
export function resetTestDb(): void {
    const db = getDb();
    db.exec(`
        DELETE FROM pgcr_players;
        DELETE FROM pgcrs;
        DELETE FROM players;
        DELETE FROM active_sessions;
        DELETE FROM crawler_state;
    `);
}
