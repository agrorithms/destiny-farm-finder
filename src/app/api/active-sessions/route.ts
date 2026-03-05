import { NextRequest, NextResponse } from 'next/server';
import { getActiveSessions } from '@/lib/db/queries';
import { getAllRaidDefinitions, getRaidNameFromHash } from '@/lib/bungie/manifest';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;

    const raidKey = searchParams.get('raid') || undefined;
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    // Validate raid key if provided
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

        // Parse the party members JSON and enrich with raid names
        const sessions = rawSessions.map((session: any) => {
            let partyMembers = [];
            try {
                partyMembers = JSON.parse(session.partyMembersJson || '[]');
            } catch {
                partyMembers = [];
            }

            return {
                membershipId: session.membershipId,
                membershipType: session.membershipType,
                displayName: session.displayName,
                activityHash: session.activityHash,
                raidKey: session.raidKey,
                raidName: getRaidNameFromHash(session.activityHash),
                startedAt: session.startedAt,
                playerCount: session.playerCount,
                partyMembers,
                checkedAt: session.checkedAt,
            };
        });

        // Deduplicate sessions by party composition
        // Multiple players in the same fireteam will create separate entries
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
 * Deduplicate sessions where multiple tracked players are in the same fireteam.
 * We group by sorted party member IDs to identify the same session.
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
