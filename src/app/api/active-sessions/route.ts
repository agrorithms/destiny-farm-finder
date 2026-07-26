import { NextRequest, NextResponse } from 'next/server';
import { formatBungieDisplayName } from '@/lib/db/queries';
import { getAllRaidDefinitions } from '@/lib/bungie/manifest';
import { getDb, isDatabaseMaintenanceError } from '@/lib/db';
import { getActivityDisplayName } from '@/lib/utils/activity';
import {
    ACTIVE_SESSION_DISPLAY_LIMIT,
    compareSessionsForDisplay,
    getDedupedActiveSessions,
} from '@/lib/active-session/dedupe';
import { withCache, withNoStore } from '@/lib/http/cache';

interface PlayerLookupRow {
    membership_id: string;
    membership_type: number;
    bungie_global_display_name: string | null;
    bungie_global_display_name_code: number | null;
    display_name: string | null;
}

interface ParsedPartyMember {
    membershipId: string;
    displayName?: string;
    status?: number;
}

interface SessionPartyMember {
    membershipId: string;
    membershipType: number | undefined;
    displayName: string;
    status: number | undefined;
}

function parsePartyMembers(rawJson: string | null): ParsedPartyMember[] {
    if (!rawJson) return [];
    try {
        const parsed: unknown = JSON.parse(rawJson);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((value): ParsedPartyMember | null => {
                if (!value || typeof value !== 'object') return null;
                const record = value as Record<string, unknown>;
                const membershipId = typeof record.membershipId === 'string'
                    ? record.membershipId
                    : String(record.membershipId || '');
                if (!membershipId) return null;
                return {
                    membershipId,
                    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
                    status: typeof record.status === 'number' ? record.status : undefined,
                };
            })
            .filter((member): member is ParsedPartyMember => member !== null);
    } catch {
        return [];
    }
}

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;

    const raidKey = searchParams.get('raid') || undefined;
    const limit = parseInt(searchParams.get('limit') || String(ACTIVE_SESSION_DISPLAY_LIMIT), 10);

    if (raidKey) {
        const raids = getAllRaidDefinitions();
        if (!raids[raidKey]) {
            return withNoStore(NextResponse.json(
                { error: `Unknown raid key: ${raidKey}`, validKeys: Object.keys(raids) },
                { status: 400 }
            ));
        }
    }

    // Number.isInteger rejects a non-numeric `limit`: parseInt returns NaN, and every NaN
    // comparison is false, so a bare range check would let it through and slice(0, NaN)
    // would return zero sessions while reporting a non-zero total.
    if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVE_SESSION_DISPLAY_LIMIT) {
        return withNoStore(NextResponse.json(
            { error: `limit must be between 1 and ${ACTIVE_SESSION_DISPLAY_LIMIT}` },
            { status: 400 }
        ));
    }

    try {
        // Dedupe into fireteams FIRST, then enrich only the survivors. Enriching before dedupe
        // meant looking up names for ~6000 membership ids to render ~250 cards, and pushed the
        // IN(...) clause toward SQLite's bind-parameter ceiling.
        const dedupedSessions = getDedupedActiveSessions(raidKey);
        const db = getDb();

        const parsedAll = dedupedSessions.map((raw) => ({
            raw,
            partyMembers: parsePartyMembers(raw.partyMembersJson),
        }));

        parsedAll.sort((a, b) => compareSessionsForDisplay(
            { memberCount: a.partyMembers.length, startedAt: a.raw.startedAt },
            { memberCount: b.partyMembers.length, startedAt: b.raw.startedAt }
        ));

        const total = parsedAll.length;
        if (total > limit) {
            console.warn(
                `[SESSIONS] Display cap hit: ${total} live fireteams, showing ${limit}.`
                + ` Raise ACTIVE_SESSION_DISPLAY_LIMIT (currently ${ACTIVE_SESSION_DISPLAY_LIMIT}) if this persists.`
            );
        }
        const parsedSessions = parsedAll.slice(0, limit);

        // Build a set of membership IDs across the sessions we will actually render
        const allMembershipIds = new Set<string>();
        for (const { partyMembers } of parsedSessions) {
            for (const member of partyMembers) {
                if (member.membershipId) {
                    allMembershipIds.add(member.membershipId);
                }
            }
        }

        // Batch lookup display names from the players table
        const nameMap = new Map<string, string>();
        const membershipTypeMap = new Map<string, number>();
        if (allMembershipIds.size > 0) {
            const placeholders = [...allMembershipIds].map(() => '?').join(',');
            const rows = db.prepare(`
        SELECT 
          membership_id,
          membership_type,
          bungie_global_display_name,
          bungie_global_display_name_code,
          display_name
        FROM players
        WHERE membership_id IN (${placeholders})
      `).all(...allMembershipIds) as PlayerLookupRow[];

            for (const row of rows) {
                membershipTypeMap.set(row.membership_id, row.membership_type);
                // Prefer "Name#1234" format if we have both parts
                nameMap.set(
                    row.membership_id,
                    formatBungieDisplayName({
                        membershipId: row.membership_id,
                        displayName: row.display_name,
                        bungieGlobalDisplayName: row.bungie_global_display_name,
                        bungieGlobalDisplayNameCode: row.bungie_global_display_name_code,
                    })
                );
            }
        }

        // Build enriched sessions
        const sessions = parsedSessions.map(({ raw, partyMembers }) => {
            const enrichedMembers: SessionPartyMember[] = partyMembers.map((member) => {
                const knownName = nameMap.get(member.membershipId);
                // Use the database name if available, otherwise fall back to what the API gave us
                const displayName = knownName
                    || (member.displayName && !isLikelyMembershipId(member.displayName)
                        ? member.displayName
                        : null)
                    || member.membershipId;

                return {
                    membershipId: member.membershipId,
                    membershipType: membershipTypeMap.get(member.membershipId),
                    displayName,
                    status: member.status,
                };
            });

            // Also enrich the session host's display name
            const hostName = nameMap.get(raw.membershipId) || raw.displayName;

            return {
                membershipId: raw.membershipId,
                membershipType: raw.membershipType,
                displayName: hostName,
                activityHash: raw.activityHash,
                activityModeHash: raw.activityModeHash,
                activityModeType: raw.activityModeType,
                raidKey: raw.raidKey,
                raidName: getActivityDisplayName(raw.activityHash, raw.activityModeType, raw.activityModeHash),
                startedAt: raw.startedAt,
                playerCount: enrichedMembers.length,
                partyMembers: enrichedMembers,
                checkedAt: raw.checkedAt,
            };
        });

        // Already deduped upstream — `sessions` is one entry per fireteam.
        return withCache(NextResponse.json({
            raidKey: raidKey || 'all',
            count: sessions.length,
            // `total` is every live fireteam; `shown` is how many fit under the display cap.
            // They differ only when the cap bites, which the page can surface to the user.
            total,
            shown: sessions.length,
            sessions,
        }), 10, 30);
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            return withNoStore(NextResponse.json({
                raidKey: raidKey || 'all',
                count: 0,
                total: 0,
                shown: 0,
                sessions: [],
                maintenance: true,
                message: 'Database maintenance is in progress. Active sessions are temporarily unavailable.',
            }));
        }

        console.error('[ERROR] Active sessions query failed:', error);
        return withNoStore(NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        ));
    }
}

/**
 * Check if a string looks like a raw membership ID (all digits, 16+ chars)
 */
function isLikelyMembershipId(str: string): boolean {
    return /^\d{16,}$/.test(str);
}

