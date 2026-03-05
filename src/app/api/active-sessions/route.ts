import { NextRequest, NextResponse } from 'next/server';
import { getActiveSessions } from '@/lib/db/queries';
import { getAllRaidDefinitions, getRaidNameFromHash } from '@/lib/bungie/manifest';
import { getDb } from '@/lib/db';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;

    const raidKey = searchParams.get('raid') || undefined;
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    if (raidKey) {
        const raids = getAllRaidDefinitions();
        if (!raids[raidKey]) {
            return NextResponse.json(
                { error: `Unknown raid key: ${raidKey}`, validKeys: Object.keys(raids) },
                { status: 400 }
            );
        }
    }

    if (limit < 1 || limit > 200) {
        return NextResponse.json(
            { error: 'limit must be between 1 and 200' },
            { status: 400 }
        );
    }

    try {
        const rawSessions = getActiveSessions(raidKey, limit);
        const db = getDb();

        // Build a set of all membership IDs across all sessions
        const allMembershipIds = new Set<string>();
        const parsedSessions: Array<{ raw: any; partyMembers: any[] }> = [];

        for (const session of rawSessions) {
            let partyMembers = [];
            try {
                partyMembers = JSON.parse(session.partyMembersJson || '[]');
            } catch {
                partyMembers = [];
            }

            for (const member of partyMembers) {
                if (member.membershipId) {
                    allMembershipIds.add(member.membershipId);
                }
            }

            parsedSessions.push({ raw: session, partyMembers });
        }

        // Batch lookup display names from the players table
        const nameMap = new Map<string, string>();
        if (allMembershipIds.size > 0) {
            const placeholders = [...allMembershipIds].map(() => '?').join(',');
            const rows = db.prepare(`
        SELECT 
          membership_id,
          bungie_global_display_name,
          bungie_global_display_name_code,
          display_name
        FROM players
        WHERE membership_id IN (${placeholders})
      `).all(...allMembershipIds) as any[];

            for (const row of rows) {
                // Prefer "Name#1234" format if we have both parts
                if (row.bungie_global_display_name && row.bungie_global_display_name_code) {
                    nameMap.set(
                        row.membership_id,
                        `${row.bungie_global_display_name}#${String(row.bungie_global_display_name_code).padStart(4, '0')}`
                    );
                } else if (row.bungie_global_display_name) {
                    nameMap.set(row.membership_id, row.bungie_global_display_name);
                } else if (row.display_name) {
                    nameMap.set(row.membership_id, row.display_name);
                }
            }
        }

        // Build enriched sessions
        const sessions = parsedSessions.map(({ raw, partyMembers }) => {
            const enrichedMembers = partyMembers.map((member: any) => {
                const knownName = nameMap.get(member.membershipId);
                // Use the database name if available, otherwise fall back to what the API gave us
                const displayName = knownName
                    || (member.displayName && !isLikelyMembershipId(member.displayName)
                        ? member.displayName
                        : null)
                    || member.membershipId;

                return {
                    membershipId: member.membershipId,
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
                raidKey: raw.raidKey,
                raidName: getRaidNameFromHash(raw.activityHash),
                startedAt: raw.startedAt,
                playerCount: enrichedMembers.length,
                partyMembers: enrichedMembers,
                checkedAt: raw.checkedAt,
            };
        });

        const deduped = deduplicateSessions(sessions);

        return NextResponse.json({
            raidKey: raidKey || 'all',
            count: deduped.length,
            sessions: deduped,
        });
    } catch (error) {
        console.error('[ERROR] Active sessions query failed:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

/**
 * Check if a string looks like a raw membership ID (all digits, 16+ chars)
 */
function isLikelyMembershipId(str: string): boolean {
    return /^\d{16,}$/.test(str);
}

/**
 * Deduplicate sessions where multiple tracked players are in the same fireteam.
 */
function deduplicateSessions(sessions: any[]): any[] {
    const seen = new Map<string, any>();

    for (const session of sessions) {
        const memberIds = (session.partyMembers || [])
            .map((m: any) => m.membershipId)
            .sort()
            .join('-');

        const key = `${session.activityHash}-${memberIds}`;

        if (!seen.has(key)) {
            seen.set(key, session);
        }
    }

    return [...seen.values()];
}
