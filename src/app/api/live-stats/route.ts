import { NextResponse } from 'next/server';
import { getCrawlerStatus, getFullClearCount } from '@/lib/db/queries';
import { countActiveRaidSessions } from '@/lib/active-session/dedupe';
import { isDatabaseMaintenanceError } from '@/lib/db';
import { withCache, withNoStore } from '@/lib/http/cache';

// Informational feed for the StatsBar — always 200, never a health check (/api/status owns that).
export async function GET() {
    try {
        const crawler = getCrawlerStatus();

        const response = NextResponse.json({
            live: crawler.isRunning,
            secondsSinceHeartbeat: crawler.secondsSinceHeartbeat,
            fullClears24h: getFullClearCount(24),
            activeRaidSessions: countActiveRaidSessions(),
            timestamp: Date.now(),
        });

        return withCache(response, 15, 30);
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            return withNoStore(NextResponse.json({
                live: false,
                secondsSinceHeartbeat: null,
                fullClears24h: 0,
                activeRaidSessions: 0,
                maintenance: true,
                timestamp: Date.now(),
            }));
        }

        console.error('[ERROR] Live stats query failed:', error);
        return withNoStore(NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        ));
    }
}
