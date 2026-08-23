import { NextRequest, NextResponse } from 'next/server';
import { isDatabaseMaintenanceError } from '@/lib/db';
import { getAllRaidDefinitions } from '@/lib/bungie/manifest';
import { envSeconds } from '@/lib/env';
import { getRaidStats, type RaidFilters } from '@/lib/db/queries';
import { getOrCompute } from '@/lib/cache/swr-cache';
import { filterKeySuffix } from '@/lib/cache/leaderboard-cache';
import { withCache, withNoStore } from '@/lib/http/cache';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const hours = parseInt(searchParams.get('hours') || '168', 10);

    if (hours < 1 || hours > 720) {
        return withNoStore(NextResponse.json(
            { error: 'hours must be between 1 and 720' },
            { status: 400 }
        ));
    }

    const difficultyParam = searchParams.get('difficulty');
    const exactPlayersParam = searchParams.get('exactPlayers');
    const maxPlayersParam = searchParams.get('maxPlayers');

    const filters: RaidFilters = {};
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

    const freshSec = envSeconds('ANALYTICS_CACHE_FRESH_SEC', 300);
    const swrSec = envSeconds('ANALYTICS_CACHE_SWR_SEC', 1800);

    const cacheKey = `raid-stats:${hours}${filterKeySuffix(hasFilters ? filters : undefined)}`;

    try {
        const { value: rows, state } = await getOrCompute(
            cacheKey,
            { freshMs: freshSec * 1000, staleMs: swrSec * 1000 },
            () => getRaidStats(hours, hasFilters ? filters : undefined),
        );

        const raids = getAllRaidDefinitions();

        const body = {
            hours,
            raids: rows.map(row => ({
                raidKey: row.raidKey,
                raidName: raids[row.raidKey]?.name || row.raidKey,
                fastestClearSeconds: row.fastestClearSeconds,
                dnfRate: row.dnfRate,
                classDistribution: row.classDistribution,
                avgKda: row.avgKda,
            })),
        };

        const response = withCache(NextResponse.json(body), freshSec, swrSec);
        response.headers.set('X-Cache', state.toUpperCase());
        return response;
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            return withNoStore(NextResponse.json({
                maintenance: true,
                message: 'Database maintenance is in progress. Analytics are temporarily unavailable.',
            }));
        }

        console.error('[ERROR] Raid stats query failed:', error);
        return withNoStore(NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        ));
    }
}
