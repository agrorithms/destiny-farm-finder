import { NextRequest, NextResponse } from 'next/server';
import { getLeaderboard, getLeaderboardByRaid } from '@/lib/db/queries';
import { getAllRaidDefinitions } from '@/lib/bungie/manifest';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;

    const raidKey = searchParams.get('raid') || undefined;
    const hoursBack = parseFloat(searchParams.get('hours') || '4');
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const fullClearsOnly = searchParams.get('fullClearsOnly') !== 'false';
    const groupByRaid = searchParams.get('groupByRaid') === 'true';

    // Validate inputs
    if (hoursBack < 0.5 || hoursBack > 24) {
        return NextResponse.json(
            { error: 'hours must be between 0.5 and 24' },
            { status: 400 }
        );
    }

    if (limit < 1 || limit > 500) {
        return NextResponse.json(
            { error: 'limit must be between 1 and 500' },
            { status: 400 }
        );
    }

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

    try {
        if (groupByRaid) {
            const leaderboards = getLeaderboardByRaid({
                hoursBack,
                limit,
                fullClearsOnly,
            });

            return NextResponse.json({
                hoursBack,
                limit,
                fullClearsOnly,
                groupedByRaid: true,
                leaderboards,
            });
        }

        const leaderboard = getLeaderboard({
            raidKey,
            hoursBack,
            limit,
            fullClearsOnly,
        });

        return NextResponse.json({
            raidKey: raidKey || 'all',
            hoursBack,
            limit,
            fullClearsOnly,
            count: leaderboard.length,
            entries: leaderboard,
        });
    } catch (error) {
        console.error('[ERROR] Leaderboard query failed:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
