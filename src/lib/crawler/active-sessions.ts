import { getBungieClient, BungieAPIError, type BungieClient } from '../bungie/client';
import { isBungieSystemDisabledError } from '../bungie/maintenance';
import { getRaidKeyFromHash, getRaidNameFromHash } from '../bungie/manifest';
import { deleteActiveSessionForPlayer, upsertActiveSession, enqueueCrawl, resolveMembershipTypes, getExistingPlayerIds, upsertPlayer, recordSessionCheck } from '../db/queries';
import { getDb } from '../db';
import { pickPrimaryLinkedProfile } from '../bungie/linked-profiles';
import { processWithConcurrency } from '../utils/concurrent';
import type { DestinyProfileResponse, PlayerInfo, RaidSession } from '../bungie/types';

// How long before a session is considered "stale" and needs re-verification
const STALE_THRESHOLD_SECONDS = 300; // 5 minutes

// How long before a session is force-deleted even if re-verification fails
const MAX_SESSION_AGE_SECONDS = Math.max(
    1,
    parseInt(process.env.MAX_ACTIVE_SESSION_AGE_SECONDS || '7200', 10)
);
const DEFAULT_ACTIVE_SESSION_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.ACTIVE_SESSION_CONCURRENCY || process.env.CRAWLER_CONCURRENCY || '4', 10)
);
const DEFAULT_STALE_SESSION_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.ACTIVE_SESSION_STALE_CONCURRENCY || String(DEFAULT_ACTIVE_SESSION_CONCURRENCY), 10)
);
const DEFAULT_STALE_SESSION_REVERIFY_LIMIT = Math.max(
    1,
    parseInt(process.env.ACTIVE_SESSION_STALE_REVERIFY_LIMIT || '200', 10)
);
const IN_ORBIT_MODE_HASHES = [2166136261];
const STALE_REVERIFY_TEAMMATE_FALLBACK_LIMIT = 2;

// Max number of unknown fireteam members to resolve to Name#Code per active-session cycle.
// Each resolution is one GetLinkedProfiles call against the crawler's API budget; the rest
// carry over to following cycles.
const DEFAULT_MEMBER_RESOLVE_LIMIT = Math.max(
    0,
    parseInt(process.env.CRAWLER_MEMBER_RESOLVE_LIMIT || '25', 10)
);

// Resolve unknown fireteam members with a little concurrency instead of one-at-a-time.
// Sequential resolution of the full limit (25) could run ~25 × fetch-timeout (~12.5 min)
// on a bad night — long enough to trip the active-session poll watchdog on its own.
const DEFAULT_MEMBER_RESOLVE_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.CRAWLER_MEMBER_RESOLVE_CONCURRENCY || '4', 10)
);

interface CharacterActivityLike {
    dateActivityStarted?: string;
    currentActivityHash?: number;
    currentActivityModeHash?: number;
    currentActivityModeType?: number;
}

interface PartyMemberLike {
    membershipId: string;
    displayName?: string;
    status?: number;
}

interface StaleSessionRow {
    membership_id: string;
    membership_type: number;
    display_name: string;
    raid_key: string | null;
    activity_mode_type: number | null;
    party_members_json: string | null;
}

// 'inactive' is a *clean* signal (transitory data present, player simply not in an
// activity). 'error' means we got no usable signal at all — a timeout / 5xx / network
// failure — and must NOT be treated as "offline": doing so lets a Bungie storm wrongly
// bench live raiders (Step 2 backoff) and delete live fireteams (stale re-verify).
export type PlayerActivityCheckStatus = 'active' | 'inactive' | 'privacyRestricted' | 'error';

export interface PlayerActivityCheckResult {
    status: PlayerActivityCheckStatus;
    session: RaidSession | null;
}

export function isBungiePrivacyRestrictionError(error: unknown): boolean {
    const errorMessage = (error as Error).message || '';

    if (error instanceof BungieAPIError) {
        return (
            error.errorStatus === 'DestinyPrivacyRestriction'
            || error.errorCode === 217
            || error.errorCode === 1601
            || error.errorCode === 1665
        );
    }

    return (
        errorMessage.includes('DestinyPrivacyRestriction')
        || errorMessage.includes('No peeking')
        || errorMessage.includes('chosen for this data to be private')
        || errorMessage.includes('"ErrorCode":1665')
    );
}

/**
 * Check if a player is currently in a raid activity and store the session.
 * Uses both Component 204 (CharacterActivities) and Component 1000 (Transitory).
 */
export async function checkPlayerActivity(
    player: PlayerInfo,
    clientOverride?: ReturnType<typeof getBungieClient>
): Promise<RaidSession | null> {
    const result = await checkPlayerActivityDetailed(player, clientOverride);
    return result.status === 'active' ? result.session : null;
}

export async function checkPlayerActivityDetailed(
    player: PlayerInfo,
    clientOverride?: ReturnType<typeof getBungieClient>
): Promise<PlayerActivityCheckResult> {
    const client = clientOverride || getBungieClient();

    try {
        const profileResponse = await fetchPlayerActivityProfile(player, client);
        return parseAndStoreActivity(player, profileResponse);
    } catch (error) {
        if (isBungieSystemDisabledError(error)) {
            throw error;
        }

        if (isBungiePrivacyRestrictionError(error)) {
            return { status: 'privacyRestricted', session: null };
        }
        // Transient failure (timeout / 5xx / network). Report 'error', not 'inactive',
        // so callers don't mistake a Bungie hiccup for the player being offline.
        console.error(`[ERROR] Unexpected error checking activity for ${player.membershipId}:`, (error as Error).message);
        return { status: 'error', session: null };
    }
}

/**
 * Fetch the raw profile components (204 + 1000) used to determine current activity.
 * Returns the `.Response` payload. Throws on Bungie errors (privacy, maintenance, etc.).
 */
export async function fetchPlayerActivityProfile(
    player: PlayerInfo,
    clientOverride?: ReturnType<typeof getBungieClient>
): Promise<DestinyProfileResponse> {
    const client = clientOverride || getBungieClient();
    const profile = await client.getProfile(
        player.membershipType,
        player.membershipId,
        [204, 1000]
    );
    return profile.Response;
}

/**
 * Parse an already-fetched profile response (components 204 + 1000) into an activity
 * result and store/clear the active session. Makes no Bungie API calls, so it can run
 * against a profile response fetched client-side.
 */
export function parseAndStoreActivity(
    player: PlayerInfo,
    profileResponse: DestinyProfileResponse
): PlayerActivityCheckResult {
    // Authoritative online/activity signal: component 1000 (transitory).
    // If absent, treat as offline and clear any stored session for this player upstream.
    const transitory = profileResponse.profileTransitoryData?.data;
    if (!transitory) {
        return { status: 'inactive', session: null };
    }

    // Use component 204 to get current activity metadata from the most recently started character activity.
    const charActivities = Object.values(
        profileResponse.characterActivities?.data || {}
    ) as CharacterActivityLike[];
    charActivities.sort((a, b) => {
        const aTs = Date.parse(a?.dateActivityStarted || '') || 0;
        const bTs = Date.parse(b?.dateActivityStarted || '') || 0;
        return bTs - aTs;
    });
    const mostRecent = charActivities[0];

    const currentActivityHash = Number(
        mostRecent?.currentActivityHash
        || transitory.currentActivity?.currentActivityHash
        || 0
    );
    const currentActivityModeHash = Number(
        mostRecent?.currentActivityModeHash
        || transitory.currentActivity?.currentActivityModeHash
        || 0
    );
    const currentActivityModeType = Number(
        mostRecent?.currentActivityModeType
        || transitory.currentActivity?.currentActivityModeType
        || 0
    );

    const activityStartedAt =
        mostRecent?.dateActivityStarted
        || transitory.currentActivity?.startTime
        || null;

    // Some valid transitory states (for example in-orbit) report an activity hash
    // while omitting mode type. Keep these sessions instead of dropping them.
    if (!currentActivityHash) {
        return { status: 'inactive', session: null };
    }

    const raidKey = getRaidKeyFromHash(currentActivityHash);
    const activityName = getRaidNameFromHash(currentActivityHash);

    // Get party members from Transitory if available
    const partyMembers = transitory?.partyMembers || [];

    let sessionKey: string;
    if (partyMembers.length > 0) {
        const sortedMemberIds = partyMembers
            .map((m: PartyMemberLike) => m.membershipId)
            .sort()
            .join('-');
        sessionKey = `${currentActivityHash}-${sortedMemberIds}`;
    } else {
        sessionKey = `${currentActivityHash}-${player.membershipId}`;
    }

    const displayName = player.displayName || player.bungieGlobalDisplayName || 'Unknown';

    const effectivePartyMembers = partyMembers.length > 0
        ? partyMembers
        : [{ membershipId: player.membershipId, displayName, status: 1, emblemHash: 0 }];

    upsertActiveSession({
        membershipId: player.membershipId,
        membershipType: player.membershipType,
        displayName,
        activityHash: currentActivityHash,
        activityModeHash: currentActivityModeHash || null,
        activityModeType: currentActivityModeType || null,
        raidKey,
        startedAt: activityStartedAt || new Date().toISOString(),
        partyMembersJson: JSON.stringify(effectivePartyMembers),
        playerCount: effectivePartyMembers.length,
    });

    return {
        status: 'active',
        session: {
            sessionKey,
            activityHash: currentActivityHash,
            activityModeHash: currentActivityModeHash || null,
            activityModeType: currentActivityModeType || null,
            raidName: activityName,
            raidKey: raidKey || 'unknown',
            players: effectivePartyMembers,
            startedAt: activityStartedAt || new Date().toISOString(),
            playerCount: effectivePartyMembers.length,
        },
    };
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
    return refreshStaleSessionsWithOptions();
}

export async function refreshStaleSessionsWithOptions(options?: {
    concurrency?: number;
    limit?: number;
}): Promise<{
    refreshed: number;
    removed: number;
}> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const concurrency = Math.max(1, options?.concurrency || DEFAULT_STALE_SESSION_CONCURRENCY);
    const limit = Math.max(1, options?.limit || DEFAULT_STALE_SESSION_REVERIFY_LIMIT);
    const client = getBungieClient();

    // Find sessions that are stale (not checked recently) but not ancient
    const inOrbitPlaceholders = IN_ORBIT_MODE_HASHES.map(() => '?').join(',');
    const staleSessions = db.prepare(`
    SELECT 
      membership_id,
      membership_type,
      display_name,
      activity_hash,
      activity_mode_hash,
      activity_mode_type,
      raid_key,
      started_at,
      checked_at,
      party_members_json
    FROM active_sessions
    WHERE checked_at < ?
      AND checked_at >= ?
    ORDER BY
      CASE
        WHEN activity_mode_type = 4 OR raid_key IS NOT NULL THEN 0
        WHEN activity_mode_hash IN (${inOrbitPlaceholders}) AND player_count >= 3 THEN 1
        ELSE 2
      END ASC,
      checked_at ASC
    LIMIT ?
  `).all(
        now - STALE_THRESHOLD_SECONDS,
        now - MAX_SESSION_AGE_SECONDS,
        ...IN_ORBIT_MODE_HASHES,
        limit
    ) as StaleSessionRow[];

    if (staleSessions.length === 0) {
        return { refreshed: 0, removed: 0 };
    }

    console.log(`[SESSIONS] Re-verifying ${staleSessions.length} stale sessions...`);

    const results = await processWithConcurrency(
        staleSessions,
        concurrency,
        async (session): Promise<'refreshed' | 'removed' | 'kept'> => {
            const player: PlayerInfo = {
                membershipId: session.membership_id,
                membershipType: session.membership_type,
                displayName: session.display_name,
            };

            const anchor = await checkPlayerActivityDetailed(player, client);

            if (anchor.status === 'active') {
                return 'refreshed';
            }

            // No usable signal on the anchor (timeout / 5xx / network): do NOT probe
            // teammates into the same storm, and do NOT delete on missing information —
            // a Bungie hiccup must not erase a live fireteam. Keep the row and retry next
            // cycle; the MAX_SESSION_AGE force-delete below is the ultimate backstop.
            if (anchor.status === 'error') {
                return 'kept';
            }

            // Anchor is cleanly gone (offline, or went private). Probe a couple teammates
            // before removing the row, so one player leaving doesn't collapse a live fireteam.
            const teammateCandidates = getTeammateCandidates(
                session.party_members_json,
                session.membership_id
            ).slice(0, STALE_REVERIFY_TEAMMATE_FALLBACK_LIMIT);

            let sawTeammateError = false;
            for (const teammate of teammateCandidates) {
                const teammateResult = await checkPlayerActivityDetailed(teammate, client);
                if (teammateResult.status === 'active') {
                    // Anchor left / went private but teammate is still active — the raid may
                    // still be in progress. Enqueue the anchor only so the completed PGCR
                    // lands as soon as they finish.
                    enqueueEndedSession(session);
                    deleteActiveSessionForPlayer(session.membership_id);
                    return 'refreshed';
                }
                if (teammateResult.status === 'error') {
                    sawTeammateError = true;
                }
            }

            // A probe returned no signal (timeout/5xx): we can't positively confirm the raid
            // ended, so don't delete on incomplete info. Keep the row and retry next cycle.
            if (sawTeammateError) {
                return 'kept';
            }

            // Positive confirmation: anchor + all probed teammates are cleanly inactive.
            // Raid ended — enqueue the full fireteam and remove the row.
            enqueueEndedSession(session);
            deleteActiveSessionForPlayer(session.membership_id);
            return 'removed';
        }
    );

    let refreshed = 0;
    let removed = 0;
    let kept = 0;
    for (const result of results) {
        if (!result.success) {
            if (isBungieSystemDisabledError(result.error)) {
                throw result.error;
            }
            continue;
        }
        if (result.result === 'refreshed') {
            refreshed++;
        } else if (result.result === 'removed') {
            removed++;
        } else {
            kept++;
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

    console.log(`[SESSIONS] Re-verification complete: ${refreshed} refreshed, ${removed} removed, ${kept} kept (no signal)`);

    return { refreshed, removed };
}

/**
 * Enqueue the anchor player and any resolvable fireteam members into the crawl queue
 * when a session is confirmed ended. Uses source='session_end' at priority 100 so the
 * crawler picks them up first on the next cycle.
 *
 * Teammates lack membershipType in party_members_json (Bungie transitory data doesn't
 * include it), so we resolve from the players table and skip unresolvable ones. The
 * anchor's single PGCR still credits all 6 participants for this raid.
 *
 * Raid-only: non-raid sessions (orbit, strikes, crucible, patrol) ending must NOT enqueue
 * their fireteam — only a raid produces a PGCR worth crawling for. The row is still deleted
 * upstream regardless.
 */
function enqueueEndedSession(session: StaleSessionRow): void {
    const isRaid = session.raid_key !== null || session.activity_mode_type === 4;
    if (!isRaid) return;

    const toEnqueue: { membershipId: string; membershipType: number; displayName: string | null }[] = [
        {
            membershipId: session.membership_id,
            membershipType: session.membership_type,
            displayName: session.display_name,
        },
    ];

    // Collect teammate membershipIds from party_members_json
    const rawTeammates = getTeammateMembershipIds(session.party_members_json, session.membership_id);

    if (rawTeammates.length > 0) {
        const resolved = resolveMembershipTypes(rawTeammates);
        for (const [id, info] of resolved) {
            toEnqueue.push({
                membershipId: id,
                membershipType: info.membershipType,
                displayName: info.displayName,
            });
        }
    }

    enqueueCrawl(toEnqueue, 'session_end', 100);
}

/** Extract teammate membershipIds (no type) from party_members_json, excluding the anchor. */
function getTeammateMembershipIds(partyMembersJson: string | null | undefined, excludeId: string): string[] {
    if (!partyMembersJson) return [];
    try {
        const members = JSON.parse(partyMembersJson) as Array<{ membershipId?: string }>;
        return members
            .map((m) => m.membershipId)
            .filter((id): id is string => !!id && id !== excludeId);
    } catch {
        return [];
    }
}

function getTeammateCandidates(partyMembersJson: string | null | undefined, excludeMembershipId: string): PlayerInfo[] {
    if (!partyMembersJson) {
        return [];
    }

    try {
        const partyMembers = JSON.parse(partyMembersJson) as Array<{
            membershipId?: string;
            membershipType?: number;
            displayName?: string;
        }>;

        return partyMembers
            .filter((m) => !!m.membershipId && m.membershipId !== excludeMembershipId)
            .map((m) => ({
                membershipId: String(m.membershipId),
                membershipType: Number.isFinite(Number(m.membershipType)) ? Number(m.membershipType) : 0,
                displayName: m.displayName || String(m.membershipId),
            }))
            .filter((m) => m.membershipType > 0);
    } catch {
        return [];
    }
}

/**
 * Check a batch of players for active raid sessions.
 * Also re-verifies stale sessions before cleaning them up.
 */
export async function pollActiveSessions(
    players: PlayerInfo[],
    maxToCheck: number = 200,
    options?: {
        playerCheckConcurrency?: number;
        staleCheckConcurrency?: number;
        staleReverifyLimit?: number;
    }
): Promise<RaidSession[]> {
    const playerCheckConcurrency = Math.max(
        1,
        options?.playerCheckConcurrency || DEFAULT_ACTIVE_SESSION_CONCURRENCY
    );
    const staleCheckConcurrency = Math.max(
        1,
        options?.staleCheckConcurrency || DEFAULT_STALE_SESSION_CONCURRENCY
    );
    const staleReverifyLimit = Math.max(
        1,
        options?.staleReverifyLimit || DEFAULT_STALE_SESSION_REVERIFY_LIMIT
    );

    const toCheck = players.slice(0, maxToCheck);
    const sessions = new Map<string, RaidSession>();
    const client = getBungieClient();

    // Step 1: Re-verify stale sessions instead of blindly deleting
    await refreshStaleSessionsWithOptions({
        concurrency: staleCheckConcurrency,
        limit: staleReverifyLimit,
    });

    // Step 2: Check players for active sessions.
    // Fireteam dedup: when a check confirms a fireteam, its members are recorded in
    // `covered`/`coveredBy`. A later task for a covered batch-teammate skips the getProfile
    // call entirely and synthesizes their row from the covering session. Because tasks run
    // concurrently, teammates already dispatched in the same window aren't skipped — so the
    // savings are workload-dependent (~6x best case), not guaranteed.
    const batchById = new Map<string, PlayerInfo>();
    for (const p of toCheck) batchById.set(p.membershipId, p);

    const covered = new Set<string>();
    const coveredBy = new Map<string, RaidSession>();
    let skippedViaFireteam = 0;

    const sessionResults = await processWithConcurrency(
        toCheck,
        playerCheckConcurrency,
        async (player): Promise<RaidSession | null> => {
            const covering = coveredBy.get(player.membershipId);
            if (covering) {
                skippedViaFireteam++;
                synthesizeSessionFromFireteam(player, covering);
                recordSessionCheck(player.membershipId, 'online');
                return covering;
            }

            const result = await checkPlayerActivityDetailed(player, client);

            if (result.status === 'active' && result.session) {
                recordSessionCheck(player.membershipId, 'online');
                // Mark batch-teammates as covered so their tasks skip the API call.
                for (const member of result.session.players) {
                    const id = member?.membershipId;
                    if (id && id !== player.membershipId && batchById.has(id) && !covered.has(id)) {
                        covered.add(id);
                        coveredBy.set(id, result.session);
                    }
                }
                return result.session;
            }

            // Transient failure (timeout / 5xx): no signal. Leave the player's session-poll
            // eligibility untouched so the next cycle retries them, instead of benching a
            // possibly-live raider on offline backoff (up to ~16 min) during a Bungie storm.
            if (result.status === 'error') {
                return null;
            }

            recordSessionCheck(
                player.membershipId,
                result.status === 'privacyRestricted' ? 'privacy' : 'offline'
            );
            return null;
        },
        (checked, total) => {
            if (checked % 50 === 0 || checked === total) {
                console.log(`[SESSIONS] Checked ${checked}/${total} players...`);
            }
        }
    );

    let checked = 0;
    for (const result of sessionResults) {
        if (!result.success) {
            if (isBungieSystemDisabledError(result.error)) {
                throw result.error;
            }
            continue;
        }
        checked++;
        const session = result.result;
        if (session && !sessions.has(session.sessionKey)) {
            sessions.set(session.sessionKey, session);
        }
    }

    console.log(
        `[SESSIONS] Active session poll complete: ${checked}/${toCheck.length} players checked` +
        ` (${skippedViaFireteam} skipped via fireteam), ${sessions.size} sessions found`
    );

    return [...sessions.values()];
}

/**
 * Synthesize an active_sessions row for a fireteam member we skipped polling (their teammate's
 * check already confirmed the fireteam online). Reuses the covering session's activity/party
 * data and the member's own membershipType/displayName from the polling batch, producing the
 * same row their own getProfile would have written — without spending an API call.
 */
function synthesizeSessionFromFireteam(player: PlayerInfo, session: RaidSession): void {
    const displayName = player.displayName || player.bungieGlobalDisplayName || 'Unknown';
    upsertActiveSession({
        membershipId: player.membershipId,
        membershipType: player.membershipType,
        displayName,
        activityHash: session.activityHash,
        activityModeHash: session.activityModeHash,
        activityModeType: session.activityModeType,
        raidKey: session.raidKey && session.raidKey !== 'unknown' ? session.raidKey : undefined,
        startedAt: session.startedAt,
        partyMembersJson: JSON.stringify(session.players),
        playerCount: session.playerCount,
    });
}

/**
 * Resolve fireteam members that appear in active sessions but aren't yet in the players table.
 * Transitory party members carry only a membershipId (no type/Name#Code), so cards fall back to
 * the raw id. We look up each unknown id via GetLinkedProfiles and upsert its identity; the
 * read-time enricher then supplies Name#Code and makes the card clickable on the next render.
 *
 * Capped per cycle (CRAWLER_MEMBER_RESOLVE_LIMIT) to bound API-budget cost; any leftover unknown
 * members are picked up on subsequent cycles. Failures (private/deleted/unresolvable) are skipped.
 */
export async function resolveUnknownPartyMembers(
    memberIds: string[],
    client: BungieClient = getBungieClient(),
    limit: number = DEFAULT_MEMBER_RESOLVE_LIMIT
): Promise<number> {
    if (limit <= 0) return 0;

    const uniqueIds = [...new Set(memberIds.filter(Boolean))];
    if (uniqueIds.length === 0) return 0;

    const known = getExistingPlayerIds(uniqueIds);
    const unknown = uniqueIds.filter((id) => !known.has(id)).slice(0, limit);
    if (unknown.length === 0) return 0;

    const results = await processWithConcurrency(
        unknown,
        DEFAULT_MEMBER_RESOLVE_CONCURRENCY,
        async (membershipId): Promise<boolean> => {
            const response = await client.getLinkedProfiles(membershipId);
            const player = pickPrimaryLinkedProfile(response.Response, membershipId);
            if (player) {
                upsertPlayer(player);
                return true;
            }
            return false;
        }
    );

    let resolved = 0;
    for (const result of results) {
        if (!result.success) {
            if (isBungieSystemDisabledError(result.error)) throw result.error;
            // Private/deleted/unresolvable — leave the membership-id fallback in place.
            continue;
        }
        if (result.result) resolved++;
    }

    if (resolved > 0) {
        console.log(`[SESSIONS] Resolved ${resolved}/${unknown.length} unknown fireteam members`);
    }
    return resolved;
}

/** Collect all fireteam membershipIds across a set of sessions (for member resolution). */
export function collectPartyMemberIds(sessions: RaidSession[]): string[] {
    const ids: string[] = [];
    for (const session of sessions) {
        for (const member of session.players) {
            if (member?.membershipId) ids.push(member.membershipId);
        }
    }
    return ids;
}
