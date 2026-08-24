import { NextRequest, NextResponse } from 'next/server';
import { isDatabaseMaintenanceError } from '@/lib/db';
import { envSeconds } from '@/lib/env';
import { getSessionHistory } from '@/lib/db/queries';
import { getOrCompute } from '@/lib/cache/swr-cache';
import { withCache, withNoStore } from '@/lib/http/cache';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const hours = parseInt(searchParams.get('hours') || '24', 10);

    if (hours < 1 || hours > 720) {
        return withNoStore(NextResponse.json(
            { error: 'hours must be between 1 and 720' },
            { status: 400 }
        ));
    }

    const freshSec = envSeconds('ANALYTICS_CACHE_FRESH_SEC', 300);
    const swrSec = envSeconds('ANALYTICS_CACHE_SWR_SEC', 1800);
    const stepdownHours = envSeconds('SESSION_HISTORY_STEPDOWN_HOURS', 24);

    const cacheKey = `session-history:${hours}`;

    try {
        const { value: points, state } = await getOrCompute(
            cacheKey,
            { freshMs: freshSec * 1000, staleMs: swrSec * 1000 },
            () => getSessionHistory(hours, stepdownHours),
        );

        const response = withCache(NextResponse.json({
            hours,
            data: points,
        }), freshSec, swrSec);
        response.headers.set('X-Cache', state.toUpperCase());
        return response;
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            return withNoStore(NextResponse.json({
                maintenance: true,
                message: 'Database maintenance is in progress. Analytics are temporarily unavailable.',
            }));
        }

        console.error('[ERROR] Session history query failed:', error);
        return withNoStore(NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        ));
    }
}
