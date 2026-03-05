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

    CREATE INDEX IF NOT EXISTS idx_pgcrs_period ON pgcrs(period);
    CREATE INDEX IF NOT EXISTS idx_pgcrs_raid_key ON pgcrs(raid_key);
    CREATE INDEX IF NOT EXISTS idx_pgcrs_raid_period ON pgcrs(raid_key, period);
    CREATE INDEX IF NOT EXISTS idx_pgcr_players_membership ON pgcr_players(membership_id);
    CREATE INDEX IF NOT EXISTS idx_pgcr_players_completed ON pgcr_players(completed);
    CREATE INDEX IF NOT EXISTS idx_players_last_crawled ON players(last_crawled_at);
    CREATE INDEX IF NOT EXISTS idx_players_priority ON players(priority DESC, last_crawled_at ASC);
    CREATE INDEX IF NOT EXISTS idx_active_sessions_raid ON active_sessions(raid_key);
  `);
}
