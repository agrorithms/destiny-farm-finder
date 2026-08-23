import { NextRequest, NextResponse } from 'next/server';
import { isDatabaseMaintenanceError } from '@/lib/db';
import { getAllRaidDefinitions } from '@/lib/bungie/manifest';
import { readLeaderboardSnapshot } from '@/lib/maintenance/snapshots';
import { withCache, withNoStore } from '@/lib/http/cache';
import { getLeaderboardResponse, type LeaderboardFilters } from '@/lib/cache/leaderboard-cache';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;

    // Support comma-separated raid keys: ?raids=garden_of_salvation,salvations_edge,vow_of_the_disciple
    const raidsParam = searchParams.get('raids') || '';
    const hours = parseInt(searchParams.get('hours') || '4', 10);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const mode = searchParams.get('mode') === 'individual' ? 'individual' : 'aggregate';
    // fullClearsOnly is forced true on the cache path (the only real UI path);
    // it is folded into the cache key as a constant rather than read here.

    const difficultyParam = searchParams.get('difficulty');
    const exactPlayersParam = searchParams.get('exactPlayers');
    const maxPlayersParam = searchParams.get('maxPlayers');

    const filters: LeaderboardFilters = {};
    if (difficultyParam === 'normal' || difficultyParam === 'master') {
        filters.difficulty = difficultyParam;
    }
    if (exactPlayersParam) {
        const parsed = parseInt(exactPlayersParam, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 6) {
            filters.exactPlayers = parsed;
        }
    } else if (maxPlayersParam) {
        const parsed = parseInt(maxPlayersParam, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 6) {
            filters.maxPlayers = parsed;
        }
    }
    const hasFilters = filters.difficulty || filters.exactPlayers != null || filters.maxPlayers != null;

    const allRaids = getAllRaidDefinitions();
    const raidKeys = raidsParam
        ? raidsParam.split(',').filter((key) => allRaids[key])
        : [];

    if (hours < 1 || hours > 720) {
        return withNoStore(NextResponse.json(
            { error: 'hours must be between 1 and 720' },
            { status: 400 }
        ));
    }

    if (limit < 1 || limit > 500) {
        return withNoStore(NextResponse.json(
            { error: 'limit must be between 1 and 500' },
            { status: 400 }
        ));
    }

    try {
        const { body, state, band } = await getLeaderboardResponse({ mode, hours, raidKeys, limit, filters: hasFilters ? filters : undefined });

        const response = withCache(NextResponse.json(body), band.sMaxAge, band.staleWhileRevalidate);
        response.headers.set('X-Cache', state.toUpperCase());
        return response;
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            const snapshot = readLeaderboardSnapshot();
            if (snapshot?.data) {
                return withNoStore(NextResponse.json({
                    ...snapshot.data,
                    maintenance: true,
                    snapshotGeneratedAt: snapshot.snapshotGeneratedAt,
                    requestedMode: mode,
                    requestedHours: hours,
                }));
            }
        }

        console.error('[ERROR] Leaderboard query failed:', error);
        return withNoStore(NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        ));
    }
}
