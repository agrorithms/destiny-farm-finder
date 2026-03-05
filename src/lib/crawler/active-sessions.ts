import { getBungieClient, BungieAPIError } from '../bungie/client';
import { isRaidActivityHash, getRaidKeyFromHash, getRaidNameFromHash } from '../bungie/manifest';
import { upsertActiveSession, clearStaleActiveSessions } from '../db/queries';
import type { PlayerInfo, RaidSession } from '../bungie/types';

/**
 * Check if a player is currently in a raid activity and store the session
 */
export async function checkPlayerActivity(
    player: PlayerInfo
): Promise<RaidSession | null> {
    const client = getBungieClient();

    try {
        // Fetch profile with Transitory (1000) and CharacterActivities (204)
        const profile = await client.getProfile(
            player.membershipType,
            player.membershipId,
            [204, 1000]
        );

        const transitory = profile.Response.profileTransitoryData?.data;

        if (!transitory || !transitory.currentActivity) {
            return null;
        }

        const currentActivityHash = transitory.currentActivity.currentActivityHash;

        // Check if they're in a raid
        if (!currentActivityHash || !isRaidActivityHash(currentActivityHash)) {
            return null;
        }

        const raidKey = getRaidKeyFromHash(currentActivityHash);
        const raidName = getRaidNameFromHash(currentActivityHash);
        const partyMembers = transitory.partyMembers || [];

        // Generate a session key to deduplicate sessions
        // Use sorted membership IDs of party members
        const sortedMemberIds = partyMembers
            .map((m) => m.membershipId)
            .sort()
            .join('-');
        const sessionKey = `${currentActivityHash}-${sortedMemberIds}`;

        // Store in database
        upsertActiveSession({
            membershipId: player.membershipId,
            membershipType: player.membershipType,
            displayName: player.displayName || player.bungieGlobalDisplayName || 'Unknown',
            activityHash: currentActivityHash,
            raidKey: raidKey,
            startedAt: transitory.currentActivity.startTime || new Date().toISOString(),
            partyMembersJson: JSON.stringify(partyMembers),
            playerCount: partyMembers.length,
        });

        return {
            sessionKey,
            activityHash: currentActivityHash,
            raidName,
            raidKey: raidKey || 'unknown',
            players: partyMembers,
            startedAt: transitory.currentActivity.startTime || new Date().toISOString(),
            playerCount: partyMembers.length,
        };
    } catch (error) {
        // Private/offline players are expected — don't log full errors for them
        if (error instanceof BungieAPIError) {
            if (
                error.errorStatus === 'DestinyPrivacyRestriction' ||
                error.errorCode === 217 ||
                error.errorCode === 1601
            ) {
                return null;
            }
        }
        // Only log unexpected errors
        console.error(`[ERROR] Unexpected error checking activity for ${player.membershipId}:`, (error as Error).message);
        return null;
    }
}

/**
 * Check a batch of players for active raid sessions.
 * Returns deduplicated sessions.
 */
export async function pollActiveSessions(
    players: PlayerInfo[],
    maxToCheck: number = 100
): Promise<RaidSession[]> {
    const sessions = new Map<string, RaidSession>();
    let checked = 0;

    // Clear stale sessions before polling
    clearStaleActiveSessions(600); // 10 minutes

    for (const player of players) {
        if (checked >= maxToCheck) break;

        const session = await checkPlayerActivity(player);
        checked++;

        if (session && !sessions.has(session.sessionKey)) {
            sessions.set(session.sessionKey, session);
        }

        // Log progress every 25 players
        if (checked % 25 === 0) {
            console.log(
                `🔍 Checked ${checked}/${Math.min(players.length, maxToCheck)} players, found ${sessions.size} active raid sessions`
            );
        }
    }

    console.log(
        `✅ Active session poll complete: ${checked} players checked, ${sessions.size} sessions found`
    );

    return [...sessions.values()];
}
