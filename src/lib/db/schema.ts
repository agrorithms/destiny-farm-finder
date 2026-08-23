import Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      membership_id TEXT PRIMARY KEY,
      membership_type INTEGER NOT NULL,
      display_name TEXT,
      bungie_global_display_name TEXT,
      bungie_global_display_name_code INTEGER,
      last_crawled_at INTEGER DEFAULT 0,
      discovered_at INTEGER NOT NULL DEFAULT (unixepoch()),
      is_active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pgcrs (
      instance_id TEXT PRIMARY KEY,
      activity_hash INTEGER NOT NULL,
      raid_key TEXT,
      period INTEGER NOT NULL,
      starting_phase_index INTEGER DEFAULT 0,
      activity_was_started_from_beginning INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      source TEXT DEFAULT 'unknown',
      player_count INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS pgcr_players (
      instance_id TEXT NOT NULL,
      membership_id TEXT NOT NULL,
      membership_type INTEGER NOT NULL,
      display_name TEXT,
      bungie_global_display_name TEXT,
      character_class TEXT,
      light_level INTEGER,
      completed INTEGER DEFAULT 0,
      kills INTEGER DEFAULT 0,
      deaths INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      time_played_seconds INTEGER DEFAULT 0,
      PRIMARY KEY (instance_id, membership_id),
      FOREIGN KEY (instance_id) REFERENCES pgcrs(instance_id)
    );

    CREATE TABLE IF NOT EXISTS active_sessions (
      membership_id TEXT NOT NULL,
      membership_type INTEGER NOT NULL,
      display_name TEXT,
      activity_hash INTEGER,
      activity_mode_hash INTEGER,
      activity_mode_type INTEGER,
      raid_key TEXT,
      started_at TEXT,
      party_members_json TEXT,
      player_count INTEGER DEFAULT 0,
      checked_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (membership_id)
    );

    CREATE TABLE IF NOT EXISTS crawler_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- idx_pgcrs_period retained: still serves cleanupOldPGCRs (period < ?) and MIN/MAX(period).
    CREATE INDEX IF NOT EXISTS idx_pgcrs_period ON pgcrs(period);
    CREATE INDEX IF NOT EXISTS idx_pgcrs_raid_key ON pgcrs(raid_key);
    CREATE INDEX IF NOT EXISTS idx_pgcr_players_membership ON pgcr_players(membership_id);
    CREATE INDEX IF NOT EXISTS idx_players_last_crawled ON players(last_crawled_at);
    CREATE INDEX IF NOT EXISTS idx_players_priority ON players(priority DESC, last_crawled_at ASC);
    CREATE INDEX IF NOT EXISTS idx_active_sessions_raid ON active_sessions(raid_key);
    CREATE INDEX IF NOT EXISTS idx_active_sessions_checked_at ON active_sessions(checked_at);

    CREATE TABLE IF NOT EXISTS crawl_queue (
      membership_id   TEXT PRIMARY KEY,
      membership_type INTEGER NOT NULL,
      display_name    TEXT,
      source          TEXT NOT NULL DEFAULT 'unknown',
      priority        INTEGER NOT NULL DEFAULT 0,
      enqueued_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_queue_drain ON crawl_queue(priority DESC, enqueued_at ASC);
  `);

    // Migration guard for existing DBs created before "source" was added.
    try {
        db.prepare(`ALTER TABLE pgcrs ADD COLUMN source TEXT DEFAULT 'unknown'`).run();
    } catch {
        // Column already exists.
    }

    // Migration guards for active session mode metadata.
    try {
        db.prepare(`ALTER TABLE active_sessions ADD COLUMN activity_mode_hash INTEGER`).run();
    } catch {
        // Column already exists.
    }
    try {
        db.prepare(`ALTER TABLE active_sessions ADD COLUMN activity_mode_type INTEGER`).run();
    } catch {
        // Column already exists.
    }

    // Migration guards for character ID caching on the players table.
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN character_ids TEXT`).run();
    } catch {
        // Column already exists.
    }
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN character_ids_updated_at INTEGER DEFAULT 0`).run();
    } catch {
        // Column already exists.
    }

    // Migration guard for denormalized run end-time (ended_at = period + duration).
    // Nullable with no default; populated at insert for new rows (Phase 1 writer).
    try {
        db.prepare(`ALTER TABLE pgcrs ADD COLUMN ended_at INTEGER`).run();
    } catch {
        // Column already exists.
    }

    // Migration guard for denormalized last-seen time on players: the max
    // pgcrs.ended_at across PGCRs the player appears in. Maintained at insert
    // (insertFullPGCR) and backfilled once via scripts/backfill-last-seen.ts.
    // Lets the tiered bucket selection read players directly instead of
    // aggregating the full pgcr_players ⋈ pgcrs join every crawl cycle.
    // Nullable: NULL means "never seen in a PGCR" → cold bucket.
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN last_seen_at INTEGER`).run();
    } catch {
        // Column already exists.
    }

    // Migration guards for crawl scheduling, decoupled from the coverage
    // watermark (last_crawled_at, advanced only on a clean successful crawl):
    //   last_attempt_at      — bumped on EVERY crawl attempt; buckets order by it,
    //                          so a failed crawl goes to the back of the line
    //                          instead of being re-picked every cycle.
    //   consecutive_failures — drives exponential backoff + auto-deactivation.
    //   next_eligible_at     — "snooze until"; buckets skip rows still backing off.
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN last_attempt_at INTEGER DEFAULT 0`).run();
        // Seed sane ordering for pre-existing rows (no-op for fresh DBs).
        db.prepare(`UPDATE players SET last_attempt_at = last_crawled_at WHERE last_attempt_at = 0`).run();
    } catch {
        // Column already exists.
    }
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN consecutive_failures INTEGER DEFAULT 0`).run();
    } catch {
        // Column already exists.
    }
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN next_eligible_at INTEGER`).run();
    } catch {
        // Column already exists.
    }

    // Migration guards for active-session poll scheduling, denormalized onto players
    // so the candidate selection (getPlayersForSessionPolling) can order/gate from a
    // single-table indexed scan instead of LEFT JOIN active_sessions + COALESCE sort.
    // Parallels the crawl-scheduling columns above:
    //   last_session_check_at      — bumped on EVERY session poll (online or offline).
    //   consecutive_offline_checks — drives exponential offline backoff; reset on online.
    //   next_session_eligible_at   — "snooze until"; candidate query skips backing-off rows.
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN last_session_check_at INTEGER DEFAULT 0`).run();
    } catch {
        // Column already exists.
    }
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN consecutive_offline_checks INTEGER DEFAULT 0`).run();
    } catch {
        // Column already exists.
    }
    try {
        db.prepare(`ALTER TABLE players ADD COLUMN next_session_eligible_at INTEGER`).run();
    } catch {
        // Column already exists.
    }

    // Migration guards for difficulty tier and unique player count on pgcrs.
    // difficulty_tier: raw Bungie activityDifficultyTier integer. NULL for pre-migration rows.
    // unique_player_count: distinct membershipIds across PGCR entries, computed at insert time.
    try {
        db.prepare(`ALTER TABLE pgcrs ADD COLUMN difficulty_tier INTEGER`).run();
    } catch {
        // Column already exists.
    }
    try {
        db.prepare(`ALTER TABLE pgcrs ADD COLUMN unique_player_count INTEGER`).run();
    } catch {
        // Column already exists.
    }

    // Phase 3 indexes for the ended_at reader cutover. Created here (after the
    // ended_at column exists) so fresh/dev DBs get them automatically; on the
    // large prod DB they are pre-built in an ingestion-paused window via
    // scripts/create-phase3-indexes.ts, making these IF NOT EXISTS no-ops.
    // No partial predicates: idx_pgcrs_ended is shared by the leaderboard
    // (all-raids) and the crawler recency queries, which do NOT filter
    // completed/started at the outer level — a predicate would exclude them.
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pgcrs_raid_ended ON pgcrs(raid_key, ended_at);
    CREATE INDEX IF NOT EXISTS idx_pgcrs_ended ON pgcrs(ended_at);
    CREATE INDEX IF NOT EXISTS idx_pgcr_players_instance_completed_member ON pgcr_players(instance_id, completed, membership_id);
    CREATE INDEX IF NOT EXISTS idx_pgcr_players_member_completed_instance ON pgcr_players(membership_id, completed, instance_id);
  `);

    // Indexes for tiered bucket selection on the denormalized last_seen_at.
    // hot/warm filter by last_seen_at range and order by last_attempt_at ASC
    // (idx_players_last_seen_attempt). idx_players_last_seen is retained for the
    // active-session polling candidate scan (orders by last_seen_at DESC).
    // (The cold bucket orders by priority and reuses idx_players_priority.)
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at, last_crawled_at);
    CREATE INDEX IF NOT EXISTS idx_players_last_seen_attempt ON players(last_seen_at, last_attempt_at);
  `);

    // Index for active-session candidate selection: the recency-window scan orders by
    // last_seen_at DESC and gates on next_session_eligible_at (offline backoff). Trailing
    // next_session_eligible_at lets the planner walk last_seen_at order and stop at LIMIT.
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_players_session_poll ON players(last_seen_at, next_session_eligible_at);
  `);
}
