import { getBungieClient, BungieAPIError } from '../bungie/client';
import { isRaidActivityHash, getRaidKeyFromHash, getRaidNameFromHash } from '../bungie/manifest';
import { upsertActiveSession, clearStaleActiveSessions, getActiveSessions } from '../db/queries';
import { getDb } from '../db';
import type { PlayerInfo, RaidSession } from '../bungie/types';

// How long before a session is considered "stale" and needs re-verification
const STALE_THRESHOLD_SECONDS = 300; // 5 minutes

// How long before a session is force-deleted even if re-verification fails
const MAX_SESSION_AGE_SECONDS = 7200; // 2 hours (no raid takes longer than this)

/**
 * Check if a player is currently in a raid activity and store the session.
 * Uses both Component 204 (CharacterActivities) and Component 1000 (Transitory).
 */
export async function checkPlayerActivity(
    player: PlayerInfo
): Promise<RaidSession | null> {
    const client = getBungieClient();

    try {
        const profile = await client.getProfile(
            player.membershipType,
            player.membershipId,
            [204, 1000]
        );

        // Strategy 1: Check Component 204 (CharacterActivities)
        let currentActivityHash: number | null = null;
        let activityStartedAt: string | null = null;

        const charActivities = profile.Response.characterActivities?.data;
        if (charActivities) {
            for (const [charId, activity] of Object.entries(charActivities) as any[]) {
                const hash = activity.currentActivityHash;
                if (hash && hash !== 0 && isRaidActivityHash(hash)) {
                    currentActivityHash = hash;
                    activityStartedAt = activity.dateActivityStarted || null;
                    break;
                }
            }
        }

        // Strategy 2: Check Component 1000 (Transitory) as fallback
        if (!currentActivityHash) {
            const transitory = profile.Response.profileTransitoryData?.data;
            if (transitory?.currentActivity) {
                const hash = transitory.currentActivity.currentActivityHash;
                if (hash && hash !== 0 && isRaidActivityHash(hash)) {
                    currentActivityHash = hash;
                    activityStartedAt = transitory.currentActivity.startTime || null;
                }
            }
        }

        if (!currentActivityHash) {
            return null;
        }

        const raidKey = getRaidKeyFromHash(currentActivityHash);
        const raidName = getRaidNameFromHash(currentActivityHash);

        // Get party members from Transitory if available
        const transitory = profile.Response.profileTransitoryData?.data;
        const partyMembers = transitory?.partyMembers || [];

        let sessionKey: string;
        if (partyMembers.length > 0) {
            const sortedMemberIds = partyMembers
                .map((m: any) => m.membershipId)
                .sort()
                .join('-');
            sessionKey = `${currentActivityHash}-${sortedMemberIds}`;
        } else {
            sessionKey = `${currentActivityHash}-${player.membershipId}`;
        }

        const displayName = player.displayName || player.bungieGlobalDisplayName || 'Unknown';

        const effectivePartyMembers = partyMembers.length > 0
            ? partyMembers
            : [{ membershipId: player.membershipId, displayName, status: 1 }];

        upsertActiveSession({
            membershipId: player.membershipId,
            membershipType: player.membershipType,
            displayName,
            activityHash: currentActivityHash,
            raidKey,
            startedAt: activityStartedAt || new Date().toISOString(),
            partyMembersJson: JSON.stringify(effectivePartyMembers),
            playerCount: effectivePartyMembers.length,
        });

        return {
            sessionKey,
            activityHash: currentActivityHash,
            raidName,
            raidKey: raidKey || 'unknown',
            players: effectivePartyMembers,
            startedAt: activityStartedAt || new Date().toISOString(),
            playerCount: effectivePartyMembers.length,
        };
    } catch (error) {
        if (error instanceof BungieAPIError) {
            if (
                error.errorStatus === 'DestinyPrivacyRestriction' ||
                error.errorCode === 217 ||
                error.errorCode === 1601
            ) {
                return null;
            }
        }
        console.error(`[ERROR] Unexpected error checking activity for ${player.membershipId}:`, (error as Error).message);
        return null;
    }
}

/**
 * Re-verify stale sessions before deleting them.
 * Checks if players in stale sessions are still in a raid.
 * If yes, refreshes their checked_at timestamp.
 * If no, removes the session.
 */
export async function refreshStaleSessions(): Promise<{
    refreshed: number;
    removed: number;
}> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    // Find sessions that are stale (not checked recently) but not ancient
    const staleSessions = db.prepare(`
    SELECT 
      membership_id,
      membership_type,
      display_name,
      activity_hash,
      started_at,
      checked_at
    FROM active_sessions
    WHERE checked_at < ?
      AND checked_at >= ?
  `).all(
        now - STALE_THRESHOLD_SECONDS,
        now - MAX_SESSION_AGE_SECONDS
    ) as any[];

    if (staleSessions.length === 0) {
        return { refreshed: 0, removed: 0 };
    }

    console.log(`[SESSIONS] Re-verifying ${staleSessions.length} stale sessions...`);

    let refreshed = 0;
    let removed = 0;

    for (const session of staleSessions) {
        const player: PlayerInfo = {
            membershipId: session.membership_id,
            membershipType: session.membership_type,
            displayName: session.display_name,
        };

        const result = await checkPlayerActivity(player);

        if (result) {
            // Still in a raid — checkPlayerActivity already updated checked_at via upsertActiveSession
            refreshed++;
        } else {
            // No longer in a raid — remove the session
            db.prepare('DELETE FROM active_sessions WHERE membership_id = ?').run(session.membership_id);
            removed++;
        }
    }

    // Force-delete anything older than MAX_SESSION_AGE_SECONDS regardless
    const ancientDeleted = db.prepare(
        'DELETE FROM active_sessions WHERE checked_at < ?'
    ).run(now - MAX_SESSION_AGE_SECONDS);

    if (ancientDeleted.changes > 0) {
        console.log(`[SESSIONS] Force-deleted ${ancientDeleted.changes} sessions older than ${MAX_SESSION_AGE_SECONDS / 60} minutes`);
        removed += ancientDeleted.changes;
    }

    console.log(`[SESSIONS] Re-verification complete: ${refreshed} refreshed, ${removed} removed`);

    return { refreshed, removed };
}

/**
 * Check a batch of players for active raid sessions.
 * Also re-verifies stale sessions before cleaning them up.
 */
export async function pollActiveSessions(
    players: PlayerInfo[],
    maxToCheck: number = 200
): Promise<RaidSession[]> {
    const sessions = new Map<string, RaidSession>();
    let checked = 0;

    // Step 1: Re-verify stale sessions instead of blindly deleting
    await refreshStaleSessions();

    // Step 2: Check new players for active sessions
    for (const player of players) {
        if (checked >= maxToCheck) break;

        const session = await checkPlayerActivity(player);
        checked++;

        if (session && !sessions.has(session.sessionKey)) {
            sessions.set(session.sessionKey, session);
        }

        if (checked % 50 === 0) {
            console.log(
                `[SESSIONS] Checked ${checked}/${Math.min(players.length, maxToCheck)} players, found ${sessions.size} active raid sessions`
            );
        }
    }

    console.log(
        `[SESSIONS] Active session poll complete: ${checked} players checked, ${sessions.size} sessions found`
    );

    return [...sessions.values()];
}
