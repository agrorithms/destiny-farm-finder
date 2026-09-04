import { getBungieClient } from '../bungie/client';
import { isBungieSystemDisabledError } from '../bungie/maintenance';
import { getRaidKeyFromHash, isRaidActivityHash } from '../bungie/manifest';
import { hasPGCR, insertFullPGCR } from '../db/queries';
import { readActivityDurationSeconds, readEntryStartSeconds } from '../bungie/pgcr-stats';
import { isoToUnix } from '../utils/helpers';
import type {
    DestinyPostGameCarnageReportData,
    PlayerInfo,
} from '../bungie/types';

export interface ProcessedPGCR {
    instanceId: string;
    activityHash: number;
    raidKey: string | undefined;
    period: number;
    completed: boolean;
    difficultyTier: number | undefined;
    uniquePlayerCount: number;
    players: PlayerInfo[];
}

/**
 * Process a raw PGCR response into our lean storage format
 */
export function processPGCR(pgcr: DestinyPostGameCarnageReportData): ProcessedPGCR {
    const activityHash = pgcr.activityDetails.directorActivityHash || pgcr.activityDetails.referenceId;
    const raidKey = getRaidKeyFromHash(activityHash);

    // Determine if the activity was completed
    // We check if ANY player has a "completed" value of 1
    const anyoneCompleted = pgcr.entries.some(
        (entry) => entry.values?.completed?.basic?.value === 1
    );

    // Extract player info
    const players: PlayerInfo[] = pgcr.entries.map((entry) => ({
        membershipId: entry.player.destinyUserInfo.membershipId,
        membershipType: entry.player.destinyUserInfo.membershipType,
        displayName: entry.player.destinyUserInfo.displayName,
        bungieGlobalDisplayName: entry.player.destinyUserInfo.bungieGlobalDisplayName,
        bungieGlobalDisplayNameCode: entry.player.destinyUserInfo.bungieGlobalDisplayNameCode,
    }));

    const uniquePlayerCount = new Set(pgcr.entries.map(
        (entry) => entry.player.destinyUserInfo.membershipId
    )).size;

    return {
        instanceId: pgcr.activityDetails.instanceId,
        activityHash,
        raidKey,
        period: isoToUnix(pgcr.period),
        completed: anyoneCompleted,
        difficultyTier: pgcr.activityDifficultyTier,
        uniquePlayerCount,
        players,
    };
}

/**
 * Fetch a PGCR from the API, process it, and store it in the database.
 * Returns the processed PGCR if it was new, or null if we already had it.
 */
export async function fetchAndStorePGCR(instanceId: string, callSource: string): Promise<ProcessedPGCR | null> {
    // Skip if we already have this PGCR
    if (hasPGCR(instanceId)) {
        return null;
    }

    const client = getBungieClient();

    try {
        const response = await client.getPGCR(instanceId);
        const pgcrData = response.Response;

        // Only store raid PGCRs
        const activityHash = pgcrData.activityDetails.directorActivityHash || pgcrData.activityDetails.referenceId;
        if (!isRaidActivityHash(activityHash)) {
            return null;
        }

        const processed = processPGCR(pgcrData);

        // Build player entries for storage
        const playerEntries = pgcrData.entries.map((entry) => ({
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
        }));

        // Store in database (single transaction)
        insertFullPGCR(
            {
                instanceId: processed.instanceId,
                activityHash: processed.activityHash,
                raidKey: processed.raidKey,
                period: processed.period,
                startingPhaseIndex: pgcrData.startingPhaseIndex || 0,
                activityWasStartedFromBeginning: pgcrData.activityWasStartedFromBeginning || false,
                completed: processed.completed,
                playerCount: pgcrData.entries.length,
                source: callSource,
                activityDurationSeconds: readActivityDurationSeconds(pgcrData.entries),
                difficultyTier: processed.difficultyTier,
                uniquePlayerCount: processed.uniquePlayerCount,
            },
            playerEntries
        );

        return processed;
    } catch (error) {
        if (isBungieSystemDisabledError(error)) {
            throw error;
        }
        console.error(`[ERROR] Error fetching PGCR ${instanceId}:`, (error as Error).message);
        return null;
    }
}
