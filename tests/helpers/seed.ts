import { getDb } from '../../src/lib/db';
import { insertFullPGCR, upsertPlayer } from '../../src/lib/db/queries';
import { getRaidKeyFromHash } from '../../src/lib/bungie/manifest';
import { processPGCR } from '../../src/lib/crawler/pgcr';
import { readActivityDurationSeconds, readEntryStartSeconds } from '../../src/lib/bungie/pgcr-stats';
import type { DestinyPostGameCarnageReportData } from '../../src/lib/bungie/types';
import { RAID_HASH } from './pgcr-builder';

/**
 * Seeds runs through the real ingestion chokepoint.
 *
 * All four production ingestion sources funnel through `insertFullPGCR`, which
 * is where `ended_at` is derived and where `players.last_seen_at` is advanced.
 * Seeding with raw INSERTs would skip both and quietly produce rows that could
 * never exist in production — so tests would pass against data the app can't
 * create. Everything here goes through the same function the crawler calls.
 */

const HOUR = 3600;

export interface SeedRunOptions {
    instanceId: string;
    /** Unix seconds the activity started. */
    period?: number;
    /** Members who finished. Each becomes a completed pgcr_players row. */
    completedBy?: string[];
    /** Members present who did not finish. */
    incompleteBy?: string[];
    activityHash?: number;
    raidKey?: string;
    /** False marks a checkpoint run, which every leaderboard excludes. */
    startedFromBeginning?: boolean;
    /** Overrides the run-level completed flag; defaults to "anyone completed". */
    completed?: boolean;
    /** Tier 1 duration. Pass null to force the Tier 2 fallback from time played. */
    activityDurationSeconds?: number | null;
    timePlayedSeconds?: number;
    startSeconds?: number | null;
    /** Raw Bungie difficulty tier integer. */
    difficultyTier?: number;
    /** Count of distinct membership IDs across entries. */
    uniquePlayerCount?: number;
}

/** Unix seconds, `hours` in the past. Runs are seeded relative to now because
 *  every leaderboard query filters on a cutoff derived from Date.now(). */
export function hoursAgo(hours: number): number {
    return Math.floor(Date.now() / 1000) - Math.round(hours * HOUR);
}

export function seedRun(options: SeedRunOptions): void {
    const {
        instanceId,
        period = hoursAgo(2),
        completedBy = [],
        incompleteBy = [],
        activityHash = RAID_HASH,
        raidKey = getRaidKeyFromHash(activityHash),
        startedFromBeginning = true,
        completed = completedBy.length > 0,
        activityDurationSeconds = 1800,
        timePlayedSeconds = 1800,
        startSeconds = 0,
        difficultyTier,
        uniquePlayerCount,
    } = options;

    const members = [
        ...completedBy.map((membershipId) => ({ membershipId, completed: true })),
        ...incompleteBy.map((membershipId) => ({ membershipId, completed: false })),
    ];

    insertFullPGCR(
        {
            instanceId,
            activityHash,
            raidKey,
            period,
            // Always 0: Bungie reports startingPhaseIndex as 0 on every run, and the
            // writer coerces it with `|| 0` anyway. Checkpoint runs are expressed through
            // startedFromBeginning, which is what the leaderboards actually filter on.
            startingPhaseIndex: 0,
            activityWasStartedFromBeginning: startedFromBeginning,
            completed,
            playerCount: members.length,
            source: 'test',
            activityDurationSeconds,
            difficultyTier,
            uniquePlayerCount,
        },
        members.map((member) => ({
            instanceId,
            membershipId: member.membershipId,
            membershipType: 3,
            displayName: `Guardian-${member.membershipId}`,
            bungieGlobalDisplayName: `Guardian-${member.membershipId}`,
            characterClass: 'Warlock',
            lightLevel: 2010,
            completed: member.completed,
            kills: 100,
            deaths: 2,
            assists: 40,
            timePlayedSeconds,
            startSeconds,
        }))
    );
}

/**
 * Registers a player in the `players` table so the leaderboard's LEFT JOIN finds
 * a name. Seeding a run alone does not do this — in production a player is only
 * added once crawled — which is exactly why the join is a LEFT one.
 */
export function seedPlayer(
    membershipId: string,
    bungieGlobalDisplayName?: string,
    bungieGlobalDisplayNameCode?: number
): void {
    upsertPlayer({
        membershipId,
        membershipType: 3,
        displayName: bungieGlobalDisplayName ?? `Guardian-${membershipId}`,
        bungieGlobalDisplayName,
        bungieGlobalDisplayNameCode,
    });
}

/**
 * Ingests a real captured PGCR through the same path the crawler uses.
 *
 * Mirrors the body of `fetchAndStorePGCR` minus the network call — the mapping
 * from Bungie's entry shape to our storage shape is duplicated there rather than
 * extracted, so this reproduces it exactly. If that mapping ever changes, this
 * must change with it.
 */
export function seedFromFixture(pgcr: DestinyPostGameCarnageReportData, source = 'test'): void {
    const processed = processPGCR(pgcr);

    insertFullPGCR(
        {
            instanceId: processed.instanceId,
            activityHash: processed.activityHash,
            raidKey: processed.raidKey,
            period: processed.period,
            startingPhaseIndex: pgcr.startingPhaseIndex || 0,
            activityWasStartedFromBeginning: pgcr.activityWasStartedFromBeginning || false,
            completed: processed.completed,
            playerCount: pgcr.entries.length,
            source,
            activityDurationSeconds: readActivityDurationSeconds(pgcr.entries),
            difficultyTier: processed.difficultyTier,
            uniquePlayerCount: processed.uniquePlayerCount,
        },
        pgcr.entries.map((entry) => ({
            instanceId: processed.instanceId,
            membershipId: entry.player.destinyUserInfo.membershipId,
            membershipType: entry.player.destinyUserInfo.membershipType,
            displayName: entry.player.destinyUserInfo.displayName,
            bungieGlobalDisplayName: entry.player.destinyUserInfo.bungieGlobalDisplayName,
            characterClass: entry.player.characterClass || 'Unknown',
            lightLevel: entry.player.lightLevel || 0,
            completed: entry.values?.completed?.basic?.value === 1,
            kills: entry.values?.kills?.basic?.value || 0,
            deaths: entry.values?.deaths?.basic?.value || 0,
            assists: entry.values?.assists?.basic?.value || 0,
            timePlayedSeconds: entry.values?.timePlayedSeconds?.basic?.value || 0,
            startSeconds: readEntryStartSeconds(entry),
        }))
    );
}

/** Raw row read, for asserting what the writer actually persisted. */
export function readPgcrRow(instanceId: string): Record<string, unknown> | undefined {
    return getDb()
        .prepare('SELECT * FROM pgcrs WHERE instance_id = ?')
        .get(instanceId) as Record<string, unknown> | undefined;
}
