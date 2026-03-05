import { getBungieClient, BungieAPIError } from '../bungie/client';
import { isRaidActivityHash } from '../bungie/manifest';
import { updateLastCrawled, upsertPlayer } from '../db/queries';
import { fetchAndStorePGCR } from './pgcr';
import { isoToUnix, hoursAgo } from '../utils/helpers';
import type { PlayerInfo } from '../bungie/types';

/**
 * Get all character IDs for a player
 */
export async function getCharacterIds(
    membershipType: number,
    membershipId: string
): Promise<string[]> {
    const client = getBungieClient();

    try {
        const profile = await client.getProfile(membershipType, membershipId, [100]);
        const characterIds = profile.Response.profile?.data?.characterIds || [];
        return characterIds;
    } catch (error) {
        if (error instanceof BungieAPIError) {
            // Error code 217 = DestinyAccountNotFound
            // Error code 1601 = DestinyAccountNotFound (alternate)
            // Error code 5 = SystemDisabled
            // ErrorStatus "DestinyPrivacyRestriction" = private profile
            if (
                error.errorStatus === 'DestinyPrivacyRestriction' ||
                error.errorCode === 217 ||
                error.errorCode === 1601
            ) {
                console.log(`[SKIP] Private/unavailable profile: ${membershipId}`);
                return [];
            }
        }
        console.error(`[ERROR] Failed to fetch characters for ${membershipId}:`, (error as Error).message);
        return [];
    }
}

/**
 * Get recent raid activity instance IDs for a single character
 */
export async function getRecentRaidActivities(
    membershipType: number,
    membershipId: string,
    characterId: string,
    hoursBack: number = 4,
    count: number = 25
): Promise<Array<{ instanceId: string; activityHash: number; period: number }>> {
    const client = getBungieClient();
    const cutoff = hoursAgo(hoursBack);

    try {
        const response = await client.getActivityHistory(
            membershipType,
            membershipId,
            characterId,
            { mode: 4, count }
        );

        const activities = response.Response.activities || [];

        return activities
            .filter((activity) => {
                const period = isoToUnix(activity.period);
                const hash = activity.activityDetails.directorActivityHash || activity.activityDetails.referenceId;
                return period >= cutoff && isRaidActivityHash(hash);
            })
            .map((activity) => ({
                instanceId: activity.activityDetails.instanceId,
                activityHash: activity.activityDetails.directorActivityHash || activity.activityDetails.referenceId,
                period: isoToUnix(activity.period),
            }));
    } catch (error) {
        if (error instanceof BungieAPIError) {
            if (
                error.errorStatus === 'DestinyPrivacyRestriction' ||
                error.errorCode === 217 ||
                error.errorCode === 1601
            ) {
                // Already logged in getCharacterIds, no need to log again
                return [];
            }
        }
        console.error(`[ERROR] Failed to fetch activity history for ${membershipId}/${characterId}:`, (error as Error).message);
        return [];
    }
}

/**
 * Crawl a single player: fetch their recent raid activities across all characters,
 * then fetch and store any new PGCRs. Returns newly discovered players.
 */
export async function crawlPlayer(
    player: PlayerInfo,
    hoursBack: number = 4
): Promise<{
    newPGCRs: number;
    discoveredPlayers: PlayerInfo[];
}> {
    let newPGCRs = 0;
    const discoveredPlayers: PlayerInfo[] = [];
    const seenMembershipIds = new Set<string>();

    try {
        // Get all character IDs
        const characterIds = await getCharacterIds(player.membershipType, player.membershipId);

        if (characterIds.length === 0) {
            console.warn(`⚠️ No characters found for ${player.displayName} (${player.membershipId})`);
            updateLastCrawled(player.membershipId);
            return { newPGCRs, discoveredPlayers };
        }

        // Get recent raid activities across all characters
        const allActivities: Array<{ instanceId: string; activityHash: number; period: number }> = [];

        for (const characterId of characterIds) {
            const activities = await getRecentRaidActivities(
                player.membershipType,
                player.membershipId,
                characterId,
                hoursBack
            );
            allActivities.push(...activities);
        }

        // Deduplicate by instance ID (same activity can appear on multiple characters)
        const uniqueActivities = new Map<string, typeof allActivities[0]>();
        for (const activity of allActivities) {
            uniqueActivities.set(activity.instanceId, activity);
        }

        // Fetch and store each new PGCR
        for (const [instanceId] of uniqueActivities) {
            const processed = await fetchAndStorePGCR(instanceId);

            if (processed) {
                newPGCRs++;

                // Discover new players from this PGCR
                for (const discoveredPlayer of processed.players) {
                    if (
                        discoveredPlayer.membershipId !== player.membershipId &&
                        !seenMembershipIds.has(discoveredPlayer.membershipId)
                    ) {
                        seenMembershipIds.add(discoveredPlayer.membershipId);
                        discoveredPlayers.push(discoveredPlayer);
                    }
                }
            }
        }

        // Update last crawled timestamp
        updateLastCrawled(player.membershipId);

        if (newPGCRs > 0) {
            console.log(
                `✅ ${player.displayName}: ${newPGCRs} new PGCRs, ${discoveredPlayers.length} new players discovered`
            );
        }
    } catch (error) {
        if (error instanceof BungieAPIError && error.errorStatus === 'DestinyPrivacyRestriction') {
            console.log(`[SKIP] Private profile: ${player.displayName} (${player.membershipId})`);
        } else {
            console.error(`[ERROR] Error crawling player ${player.displayName}:`, (error as Error).message);
        }
        updateLastCrawled(player.membershipId);
    }

    return { newPGCRs, discoveredPlayers };
}
