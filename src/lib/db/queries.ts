import { getDb } from './index';
import type { PlayerInfo, LeaderboardEntry } from '../bungie/types';

// =====================
// PLAYER QUERIES
// =====================

export function upsertPlayer(player: PlayerInfo): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO players (membership_id, membership_type, display_name, bungie_global_display_name, bungie_global_display_name_code)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(membership_id) DO UPDATE SET
      display_name = excluded.display_name,
      bungie_global_display_name = COALESCE(excluded.bungie_global_display_name, bungie_global_display_name),
      bungie_global_display_name_code = COALESCE(excluded.bungie_global_display_name_code, bungie_global_display_name_code)
  `).run(
        player.membershipId,
        player.membershipType,
        player.displayName,
        player.bungieGlobalDisplayName || null,
        player.bungieGlobalDisplayNameCode || null
    );
}

export function bulkUpsertPlayers(players: PlayerInfo[]): void {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT INTO players (membership_id, membership_type, display_name, bungie_global_display_name, bungie_global_display_name_code)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(membership_id) DO UPDATE SET
      display_name = excluded.display_name,
      bungie_global_display_name = COALESCE(excluded.bungie_global_display_name, bungie_global_display_name),
      bungie_global_display_name_code = COALESCE(excluded.bungie_global_display_name_code, bungie_global_display_name_code)
  `);

    const insertMany = db.transaction((players: PlayerInfo[]) => {
        for (const p of players) {
            stmt.run(
                p.membershipId,
                p.membershipType,
                p.displayName,
                p.bungieGlobalDisplayName || null,
                p.bungieGlobalDisplayNameCode || null
            );
        }
    });

    insertMany(players);
}

export function getPlayersToCrawl(limit: number = 50): PlayerInfo[] {
    const db = getDb();
    return db.prepare(`
    SELECT 
      membership_id as membershipId, 
      membership_type as membershipType,
      display_name as displayName, 
      bungie_global_display_name as bungieGlobalDisplayName,
      last_crawled_at as lastCrawledAt
    FROM players
    WHERE is_active = 1
    ORDER BY priority DESC, last_crawled_at ASC
    LIMIT ?
  `).all(limit) as PlayerInfo[];
}

export function updateLastCrawled(membershipId: string): void {
    const db = getDb();
    db.prepare(`
    UPDATE players SET last_crawled_at = unixepoch() WHERE membership_id = ?
  `).run(membershipId);
}

export function getPlayerCount(): number {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM players').get() as any;
    return row.count;
}

// =====================
// PGCR QUERIES
// =====================

export function hasPGCR(instanceId: string): boolean {
    const db = getDb();
    const row = db.prepare('SELECT 1 FROM pgcrs WHERE instance_id = ?').get(instanceId);
    return !!row;
}

export function insertFullPGCR(
    pgcrData: {
        instanceId: string;
        activityHash: number;
        raidKey: string | undefined;
        period: number;
        startingPhaseIndex: number;
        activityWasStartedFromBeginning: boolean;
        completed: boolean;
        playerCount: number;
    },
    players: Array<{
        instanceId: string;
        membershipId: string;
        membershipType: number;
        displayName: string;
        bungieGlobalDisplayName?: string;
        characterClass: string;
        lightLevel: number;
        completed: boolean;
        kills: number;
        deaths: number;
        assists: number;
        timePlayedSeconds: number;
    }>
): void {
    const db = getDb();

    const insertPGCRStmt = db.prepare(`
    INSERT OR IGNORE INTO pgcrs 
    (instance_id, activity_hash, raid_key, period, starting_phase_index, 
     activity_was_started_from_beginning, completed, player_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

    const insertPlayerStmt = db.prepare(`
    INSERT OR IGNORE INTO pgcr_players 
    (instance_id, membership_id, membership_type, display_name, 
     bungie_global_display_name, character_class, light_level, 
     completed, kills, deaths, assists, time_played_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

    const transaction = db.transaction(() => {
        insertPGCRStmt.run(
            pgcrData.instanceId,
            pgcrData.activityHash,
            pgcrData.raidKey || null,
            pgcrData.period,
            pgcrData.startingPhaseIndex,
            pgcrData.activityWasStartedFromBeginning ? 1 : 0,
            pgcrData.completed ? 1 : 0,
            pgcrData.playerCount
        );

        for (const player of players) {
            insertPlayerStmt.run(
                player.instanceId,
                player.membershipId,
                player.membershipType,
                player.displayName,
                player.bungieGlobalDisplayName || null,
                player.characterClass,
                player.lightLevel,
                player.completed ? 1 : 0,
                player.kills,
                player.deaths,
                player.assists,
                player.timePlayedSeconds
            );
        }
    });

    transaction();
}

export function getPGCRCount(): number {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM pgcrs').get() as any;
    return row.count;
}

// =====================
// LEADERBOARD QUERIES
// =====================

export function getLeaderboard(params: {
    raidKey?: string;
    hoursBack: number;
    limit?: number;
    fullClearsOnly?: boolean;
}): LeaderboardEntry[] {
    const db = getDb();
    const { raidKey, hoursBack, limit = 100, fullClearsOnly = true } = params;

    const cutoffTimestamp = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);

    let query = `
    SELECT 
      pp.membership_id as membershipId,
      pp.membership_type as membershipType,
      pp.display_name as displayName,
      pp.bungie_global_display_name as bungieGlobalDisplayName,
      COUNT(DISTINCT pp.instance_id) as completions,
      COALESCE(p.raid_key, 'unknown') as raidName
    FROM pgcr_players pp
    JOIN pgcrs p ON pp.instance_id = p.instance_id
    WHERE p.period >= ?
      AND pp.completed = 1
      AND p.completed = 1
  `;

    const queryParams: any[] = [cutoffTimestamp];

    // Filter to full clears only (started from beginning)
    if (fullClearsOnly) {
        query += ` AND p.activity_was_started_from_beginning = 1`;
    }

    // Filter to specific raid
    if (raidKey) {
        query += ` AND p.raid_key = ?`;
        queryParams.push(raidKey);
    }

    query += `
    GROUP BY pp.membership_id
    ORDER BY completions DESC
    LIMIT ?
  `;
    queryParams.push(limit);

    return db.prepare(query).all(...queryParams) as LeaderboardEntry[];
}

export function getLeaderboardByRaid(params: {
    hoursBack: number;
    limit?: number;
    fullClearsOnly?: boolean;
}): Record<string, LeaderboardEntry[]> {
    const db = getDb();
    const { hoursBack, limit = 50, fullClearsOnly = true } = params;

    const cutoffTimestamp = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);

    let query = `
    SELECT 
      pp.membership_id as membershipId,
      pp.membership_type as membershipType,
      pp.display_name as displayName,
      pp.bungie_global_display_name as bungieGlobalDisplayName,
      COUNT(DISTINCT pp.instance_id) as completions,
      p.raid_key as raidKey
    FROM pgcr_players pp
    JOIN pgcrs p ON pp.instance_id = p.instance_id
    WHERE p.period >= ?
      AND pp.completed = 1
      AND p.completed = 1
      AND p.raid_key IS NOT NULL
  `;

    const queryParams: any[] = [cutoffTimestamp];

    if (fullClearsOnly) {
        query += ` AND p.activity_was_started_from_beginning = 1`;
    }

    query += `
    GROUP BY p.raid_key, pp.membership_id
    ORDER BY p.raid_key, completions DESC
  `;

    const rows = db.prepare(query).all(...queryParams) as (LeaderboardEntry & { raidKey: string })[];

    // Group by raid and limit each
    const grouped: Record<string, LeaderboardEntry[]> = {};
    for (const row of rows) {
        if (!grouped[row.raidKey]) {
            grouped[row.raidKey] = [];
        }
        if (grouped[row.raidKey].length < limit) {
            grouped[row.raidKey].push(row);
        }
    }

    return grouped;
}

// =====================
// ACTIVE SESSION QUERIES
// =====================

export function upsertActiveSession(session: {
    membershipId: string;
    membershipType: number;
    displayName: string;
    activityHash: number;
    raidKey: string | undefined;
    startedAt: string;
    partyMembersJson: string;
    playerCount: number;
}): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO active_sessions 
    (membership_id, membership_type, display_name, activity_hash, raid_key, 
     started_at, party_members_json, player_count, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(membership_id) DO UPDATE SET
      activity_hash = excluded.activity_hash,
      raid_key = excluded.raid_key,
      started_at = excluded.started_at,
      party_members_json = excluded.party_members_json,
      player_count = excluded.player_count,
      checked_at = unixepoch()
  `).run(
        session.membershipId,
        session.membershipType,
        session.displayName,
        session.activityHash,
        session.raidKey || null,
        session.startedAt,
        session.partyMembersJson,
        session.playerCount
    );
}

export function getActiveSessions(raidKey?: string, limit: number = 50): any[] {
    const db = getDb();

    // Only show sessions checked within the last 10 minutes
    const freshnessCutoff = Math.floor(Date.now() / 1000) - 600;

    let query = `
    SELECT 
      membership_id as membershipId,
      membership_type as membershipType,
      display_name as displayName,
      activity_hash as activityHash,
      raid_key as raidKey,
      started_at as startedAt,
      party_members_json as partyMembersJson,
      player_count as playerCount,
      checked_at as checkedAt
    FROM active_sessions
    WHERE checked_at >= ?
  `;

    const queryParams: any[] = [freshnessCutoff];

    if (raidKey) {
        query += ` AND raid_key = ?`;
        queryParams.push(raidKey);
    }

    query += ` ORDER BY started_at DESC LIMIT ?`;
    queryParams.push(limit);

    return db.prepare(query).all(...queryParams);
}

export function clearStaleActiveSessions(maxAgeSeconds: number = 600): void {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    db.prepare('DELETE FROM active_sessions WHERE checked_at < ?').run(cutoff);
}

// =====================
// CLEANUP QUERIES
// =====================

export function cleanupOldPGCRs(maxAgeHours: number = 6): { pgcrsDeleted: number; playersDeleted: number } {
    const db = getDb();
    const cutoff = Math.floor((Date.now() - maxAgeHours * 60 * 60 * 1000) / 1000);

    const pgcrResult = db.prepare(`
    DELETE FROM pgcr_players WHERE instance_id IN (
      SELECT instance_id FROM pgcrs WHERE period < ?
    )
  `).run(cutoff);

    const playerResult = db.prepare('DELETE FROM pgcrs WHERE period < ?').run(cutoff);

    return {
        pgcrsDeleted: playerResult.changes,
        playersDeleted: pgcrResult.changes,
    };
}

// =====================
// STATS / DEBUG QUERIES
// =====================

export function getDbStats(): {
    totalPlayers: number;
    totalPGCRs: number;
    totalPGCRPlayers: number;
    activeSessions: number;
    oldestPGCR: string | null;
    newestPGCR: string | null;
} {
    const db = getDb();

    const players = (db.prepare('SELECT COUNT(*) as c FROM players').get() as any).c;
    const pgcrs = (db.prepare('SELECT COUNT(*) as c FROM pgcrs').get() as any).c;
    const pgcrPlayers = (db.prepare('SELECT COUNT(*) as c FROM pgcr_players').get() as any).c;
    const sessions = (db.prepare('SELECT COUNT(*) as c FROM active_sessions').get() as any).c;

    const oldest = db.prepare('SELECT MIN(period) as p FROM pgcrs').get() as any;
    const newest = db.prepare('SELECT MAX(period) as p FROM pgcrs').get() as any;

    return {
        totalPlayers: players,
        totalPGCRs: pgcrs,
        totalPGCRPlayers: pgcrPlayers,
        activeSessions: sessions,
        oldestPGCR: oldest.p ? new Date(oldest.p * 1000).toISOString() : null,
        newestPGCR: newest.p ? new Date(newest.p * 1000).toISOString() : null,
    };
}

// =====================
// CRAWLER STATE QUERIES
// =====================

export function getCrawlerStatus(): {
    isRunning: boolean;
    lastHeartbeat: string | null;
    status: string;
    secondsSinceHeartbeat: number | null;
} {
    const db = getDb();

    const heartbeatRow = db.prepare(
        "SELECT value, updated_at FROM crawler_state WHERE key = 'heartbeat'"
    ).get() as { value: string; updated_at: number } | undefined;

    const statusRow = db.prepare(
        "SELECT value FROM crawler_state WHERE key = 'status'"
    ).get() as { value: string } | undefined;

    const now = Math.floor(Date.now() / 1000);

    if (!heartbeatRow) {
        return {
            isRunning: false,
            lastHeartbeat: null,
            status: 'never_started',
            secondsSinceHeartbeat: null,
        };
    }

    const secondsSinceHeartbeat = now - heartbeatRow.updated_at;

    // Consider the crawler "running" if we got a heartbeat within the last 3 minutes
    // This accounts for the crawl interval (90s) plus some buffer
    const isRunning = secondsSinceHeartbeat < 180;

    return {
        isRunning,
        lastHeartbeat: heartbeatRow.value,
        status: isRunning ? (statusRow?.value || 'running') : 'stale',
        secondsSinceHeartbeat,
    };
}
