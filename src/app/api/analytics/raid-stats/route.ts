import { NextRequest, NextResponse } from 'next/server';
import { isDatabaseMaintenanceError } from '@/lib/db';
import { getAllRaidDefinitions } from '@/lib/bungie/manifest';
import { getRaidStats, type RaidStatsFilters } from '@/lib/db/queries';
import { getOrCompute } from '@/lib/cache/swr-cache';
import { withCache, withNoStore } from '@/lib/http/cache';

function envSeconds(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
    const maxPlayersParam = searchParams.get('maxPlayers');

    const filters: RaidStatsFilters = {};
    if (difficultyParam === 'normal' || difficultyParam === 'master') {
        filters.difficulty = difficultyParam;
    }
    if (maxPlayersParam) {
        const parsed = parseInt(maxPlayersParam, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 6) {
            filters.maxPlayers = parsed;
        }
    }
    const hasFilters = filters.difficulty || filters.maxPlayers != null;

    const freshSec = envSeconds('ANALYTICS_CACHE_FRESH_SEC', 300);
    const swrSec = envSeconds('ANALYTICS_CACHE_SWR_SEC', 1800);

    let filterSuffix = '';
    if (filters.difficulty) filterSuffix += `:d=${filters.difficulty}`;
    if (filters.maxPlayers != null) filterSuffix += `:mp=${filters.maxPlayers}`;

    const cacheKey = `raid-stats:${hours}${filterSuffix}`;

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
