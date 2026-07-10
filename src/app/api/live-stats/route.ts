import { NextResponse } from 'next/server';
import { getCrawlerStatus, getFullClearCount } from '@/lib/db/queries';
import { countActiveRaidSessions } from '@/lib/active-session/dedupe';
import { isDatabaseMaintenanceError } from '@/lib/db';
import { getBungieMaintenanceStatus } from '@/lib/bungie/maintenance';
import { withCache, withNoStore } from '@/lib/http/cache';

// Informational feed for the StatsBar — always 200, never a health check (/api/status owns that).
// Also carries the maintenance flags and heartbeat consumed by FooterStatus and
// BungieMaintenanceAlert, so browser tabs poll this single endpoint.

interface LiveStatsPayload {
    live: boolean;
    secondsSinceHeartbeat: number | null;
    fullClears24h: number;
    activeRaidSessions: number;
    bungieMaintenanceActive: boolean;
    dbQuiesceActive: boolean;
    timestamp: number;
}

// s-maxage only helps behind a CDN configured to cache /api/*; this in-process memo
// caps DB cost per worker no matter how many tabs poll. Error paths stay uncached.
const CACHE_TTL_MS = 15_000;
let cached: { data: LiveStatsPayload; expiresAt: number } | null = null;

export async function GET() {
    try {
        const now = Date.now();

        if (!cached || cached.expiresAt <= now) {
            const crawler = getCrawlerStatus();
            const maintenance = getBungieMaintenanceStatus();

            cached = {
                data: {
                    live: crawler.isRunning,
                    secondsSinceHeartbeat: crawler.secondsSinceHeartbeat,
                    fullClears24h: getFullClearCount(24),
                    activeRaidSessions: countActiveRaidSessions(),
                    bungieMaintenanceActive: maintenance.active,
                    dbQuiesceActive: maintenance.dbQuiesceActive,
                    timestamp: now,
                },
                expiresAt: now + CACHE_TTL_MS,
            };
        }

        return withCache(NextResponse.json(cached.data), 15, 30);
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            const maintenance = getBungieMaintenanceStatus();

            return withNoStore(NextResponse.json({
                live: false,
                secondsSinceHeartbeat: null,
                fullClears24h: 0,
                activeRaidSessions: 0,
                bungieMaintenanceActive: maintenance.active,
                dbQuiesceActive: maintenance.dbQuiesceActive,
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
