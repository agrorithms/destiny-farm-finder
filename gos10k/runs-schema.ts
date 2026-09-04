import type Database from 'better-sqlite3';

/**
 * The gos_10k_runs table definition, in one place.
 *
 * Extracted because it had been hand-retyped in the smoke test's seeder. A
 * seeder that drifts from the real schema is worse than no seeder: the tests go
 * green while asserting against rows the actual crawl could never produce. Both
 * gos_10k.ts and the smoke test now build the table from this string, so there
 * is nothing to drift.
 *
 * Columns added later by the PGCR backfill live in initPgcrSchema() as guarded
 * ALTERs, not here — this is the shape a fresh history crawl creates.
 */
export const GOS_10K_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS gos_10k_runs (
    instance_id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    activity_hash INTEGER NOT NULL,
    raid_key TEXT,
    period INTEGER NOT NULL,
    ended_at INTEGER,
    -- DEFAULT 0 predates the PGCR pass and SQLite cannot drop a default, so it
    -- stays. It is not the ambiguity it looks like: after the backfill, these
    -- two are only meaningful where pgcr_fetch_status = 'ok', and that column
    -- is what separates "never checked" from a real zero. Read them together.
    duration_seconds INTEGER DEFAULT 0,
    player_count INTEGER DEFAULT 0,
    completion_reason INTEGER,
    -- NULL until the backfill reads them off the PGCR endpoint. Activity
    -- History does not carry either field, so anything written here from a
    -- history row would be invented. Deliberately no DEFAULT: 0 is a real
    -- phase index and must not be confused with "not yet checked".
    starting_phase_index INTEGER,
    activity_was_started_from_beginning INTEGER,
    completed INTEGER DEFAULT 0,
    source TEXT DEFAULT 'unknown',
    fetched_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_gos_10k_runs_period ON gos_10k_runs(period);
`;

export function createRunsTable(db: Database.Database): void {
    db.exec(GOS_10K_RUNS_DDL);
}
