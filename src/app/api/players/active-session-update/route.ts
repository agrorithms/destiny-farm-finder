import { NextRequest, NextResponse } from 'next/server';
import { parseAndStoreActivity } from '@/lib/crawler/active-sessions';
import { buildActiveSessionPayload, enrichPartyMembersFromJson } from '@/lib/active-session/format';
import { isDatabaseMaintenanceError } from '@/lib/db';
import {
    deleteActiveSessionForPlayer,
    formatBungieDisplayName,
    getActiveSessionContainingPlayer,
    getActiveSessionForPlayer,
    getPlayerIdentity,
    upsertPlayerFillOnly,
    type PlayerIdentity,
} from '@/lib/db/queries';
import { withNoStore } from '@/lib/http/cache';
import { getClientIp } from '@/lib/http/request-ip';
import { isTrustedClientWrite } from '@/lib/http/request-auth';
import { CooldownGate } from '@/lib/http/rate-limit';
import type { DestinyProfileResponse } from '@/lib/bungie/types';

const validMembershipTypes = new Set([1, 2, 3, 5, 6]);

// Per-IP + per-player cooldown: at most one update per player per 30s from a given IP.
const updateCooldown = new CooldownGate(30_000);

// Reasonableness bounds for a session start time.
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;

interface UpdateBody {
    membershipId?: unknown;
    membershipType?: unknown;
    profileResponse?: unknown;
}

function buildFallbackIdentity(membershipType: number, membershipId: string): PlayerIdentity {
    return {
        membershipId,
        membershipType,
        displayName: null,
        bungieGlobalDisplayName: null,
        bungieGlobalDisplayNameCode: null,
    };
}

// Party members the enricher couldn't resolve to a real identity (no membershipType => not in
// the players table). The browser resolves these via GetLinkedProfiles and POSTs them to
// /api/players/identity so their cards show Name#Code + a clickable link.
function unresolvedMemberIds(
    partyMembers: Array<{ membershipId?: string; membershipType?: number }> | undefined,
    selfMembershipId: string
): string[] {
    if (!partyMembers) return [];
    return partyMembers
        .filter((m) => !!m.membershipId && m.membershipId !== selfMembershipId && typeof m.membershipType !== 'number')
        .map((m) => m.membershipId as string);
}

function buildPlayerPayload(identity: PlayerIdentity) {
    return {
        membershipId: identity.membershipId,
        membershipType: identity.membershipType,
        displayName: formatBungieDisplayName(identity),
        baseName: identity.bungieGlobalDisplayName || identity.displayName || identity.membershipId,
    };
}

/**
 * A profile is "private" (incomplete) when the account is marked non-public, or when the
 * CharacterActivities (204) component is withheld (`privacy: 2`, no `data`). In that case we
 * can't read which activity they're in, so we fall back to DB / teammate resolution.
 */
function isProfilePrivate(profile: DestinyProfileResponse): boolean {
    if (profile.profile?.data?.userInfo?.isPublic === false) return true;
    const charActivities = profile.characterActivities;
    if (charActivities && !charActivities.data) return true;
    return false;
}

/**
 * Defense against fabricated timestamps: blank out any start time that is in the future
 * or older than 24h so parseAndStoreActivity stamps `now` instead. Activity-hash validity
 * is already governed by the raid manifest inside parseAndStoreActivity (same as the crawler).
 */
function sanitizeStartTimes(profileResponse: DestinyProfileResponse): void {
    const now = Date.now();
    const isReasonable = (iso?: string | null): boolean => {
        if (!iso) return false;
        const t = Date.parse(iso);
        if (Number.isNaN(t)) return false;
        return t <= now + MAX_FUTURE_SKEW_MS && t >= now - MAX_AGE_MS;
    };

    const charData = profileResponse.characterActivities?.data;
    if (charData) {
        for (const activity of Object.values(charData)) {
            if (activity && !isReasonable(activity.dateActivityStarted)) {
                activity.dateActivityStarted = '';
            }
        }
    }

    const currentActivity = profileResponse.profileTransitoryData?.data?.currentActivity;
    if (currentActivity && !isReasonable(currentActivity.startTime)) {
        currentActivity.startTime = '';
    }
}

// The client fetches its own Bungie profile (public key) and POSTs the raw response here.
// The server makes NO Bungie call — it only parses the supplied JSON, upserts identity +
// active session, and returns the enriched session for display.
export async function POST(request: NextRequest) {
    if (!isTrustedClientWrite(request)) {
        return withNoStore(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    }

    let body: UpdateBody;
    try {
        body = await request.json();
    } catch {
        return withNoStore(NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }));
    }

    const membershipId = typeof body.membershipId === 'string' ? body.membershipId.trim() : '';
    const membershipType = Number(body.membershipType);
    const profileResponse = body.profileResponse;

    if (!/^\d{1,20}$/.test(membershipId)) {
        return withNoStore(NextResponse.json({ error: 'Invalid membershipId' }, { status: 400 }));
    }
    if (!validMembershipTypes.has(membershipType)) {
        return withNoStore(NextResponse.json({ error: 'Invalid membershipType' }, { status: 400 }));
    }
    if (!profileResponse || typeof profileResponse !== 'object') {
        return withNoStore(NextResponse.json({ error: 'Missing profileResponse' }, { status: 400 }));
    }

    // Account-wide-private (1665) players never reach this endpoint: the browser can't fetch
    // their profile, so it reads their containing session via
    // GET /api/players/{type}/{id}?part=active&containing=1 instead.
    const ip = getClientIp(request);
    const rateKey = `${ip}:${membershipType}:${membershipId}`;
    if (updateCooldown.isCoolingDown(rateKey)) {
        return withNoStore(NextResponse.json({ skipped: true, reason: 'recently_updated' }));
    }
    updateCooldown.record(rateKey);

    try {
        const profile = profileResponse as DestinyProfileResponse;

        // Hydrate identity from component 100 (so untracked players become known).
        // Fill-only: the payload is client-supplied, so it must never overwrite a
        // name the crawler already established for an existing player.
        const userInfo = profile.profile?.data?.userInfo;
        if (userInfo?.membershipId) {
            upsertPlayerFillOnly({
                membershipId: userInfo.membershipId,
                membershipType: userInfo.membershipType,
                displayName: userInfo.displayName,
                bungieGlobalDisplayName: userInfo.bungieGlobalDisplayName,
                bungieGlobalDisplayNameCode: userInfo.bungieGlobalDisplayNameCode,
            });
        }

        const identity = getPlayerIdentity(membershipId) || buildFallbackIdentity(membershipType, membershipId);

        sanitizeStartTimes(profile);

        const isPrivate = isProfilePrivate(profile);

        const result = parseAndStoreActivity(
            {
                membershipId,
                membershipType,
                displayName: identity.displayName || identity.bungieGlobalDisplayName || membershipId,
                bungieGlobalDisplayName: identity.bungieGlobalDisplayName || undefined,
                bungieGlobalDisplayNameCode: identity.bungieGlobalDisplayNameCode ?? undefined,
            },
            profile
        );

        // We could read their activity hash directly → store + show their own session.
        if (result.status === 'active') {
            const stored = getActiveSessionForPlayer(membershipId, 600);
            const activeSession = buildActiveSessionPayload(stored, identity, { enrichPartyMembers: true });
            return withNoStore(NextResponse.json({
                updated: true,
                privacyRestricted: isPrivate,
                player: buildPlayerPayload(identity),
                activeSession,
                unresolvedMemberIds: unresolvedMemberIds(activeSession?.partyMembers, membershipId),
            }));
        }

        // Inactive AND public → genuinely not in an activity: clear their session.
        if (!isPrivate) {
            deleteActiveSessionForPlayer(membershipId);
            return withNoStore(NextResponse.json({
                updated: true,
                player: buildPlayerPayload(identity),
                activeSession: null,
            }));
        }

        // Inactive AND private → we couldn't see their activity. Do NOT delete their session.
        // Fallback A: any stored session that already contains them (from a public teammate).
        const containing = getActiveSessionContainingPlayer(membershipId, 900);
        if (containing) {
            return withNoStore(NextResponse.json({
                updated: false,
                privacyRestricted: true,
                player: buildPlayerPayload(identity),
                activeSession: buildActiveSessionPayload(containing, identity, { enrichPartyMembers: true }),
            }));
        }

        // Fallback B: no stored session yet, but transitory shows them in a live fireteam.
        // Return a provisional card + resolvable teammate IDs so the browser can probe a
        // public member and resolve the real raid.
        const transitory = profile.profileTransitoryData?.data;
        const currentActivity = transitory?.currentActivity;
        if (currentActivity?.startTime) {
            const enrichedParty = enrichPartyMembersFromJson(
                JSON.stringify(transitory?.partyMembers ?? []),
                true
            );
            const candidateMembers = enrichedParty
                .filter((m) => m.membershipId !== membershipId && typeof m.membershipType === 'number')
                .slice(0, 4)
                .map((m) => ({ membershipId: m.membershipId, membershipType: m.membershipType as number }));

            return withNoStore(NextResponse.json({
                updated: false,
                privacyRestricted: true,
                player: buildPlayerPayload(identity),
                activeSession: null,
                provisionalSession: {
                    membershipId,
                    membershipType,
                    displayName: formatBungieDisplayName(identity),
                    activityHash: 0,
                    raidKey: 'unknown',
                    raidName: 'Activity in progress (details private)',
                    startedAt: currentActivity.startTime,
                    playerCount: currentActivity.numberOfPlayers || enrichedParty.length,
                    partyMembers: enrichedParty,
                },
                candidateMembers,
                unresolvedMemberIds: unresolvedMemberIds(enrichedParty, membershipId),
            }));
        }

        // Private, not in any activity.
        return withNoStore(NextResponse.json({
            updated: false,
            privacyRestricted: true,
            player: buildPlayerPayload(identity),
            activeSession: null,
        }));
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            return withNoStore(NextResponse.json({ skipped: true, reason: 'maintenance' }, { status: 503 }));
        }
        console.error('[ERROR] active-session-update failed:', error);
        return withNoStore(NextResponse.json({ error: 'Internal server error' }, { status: 500 }));
    }
}
