import { NextResponse } from 'next/server';
import { getStatusStats } from '@/lib/system-stats';
import { getBungieMaintenanceStatus } from '@/lib/bungie/maintenance';
import { isDatabaseMaintenanceError } from '@/lib/db';
import { readStatusSnapshot } from '@/lib/maintenance/snapshots';
import { withCache, withNoStore } from '@/lib/http/cache';

export async function GET() {
    try {
        const stats = getStatusStats();
        const crawlHeartbeatStale = (stats.secondsSinceHeartbeat ?? 301) > 300; // 5 minutes

        // Session loop is degraded when no poll has *completed* within the configured window.
        // Default 15 min sits above one 10-min watchdog cycle, so a single trip doesn't flip
        // the verdict but a persistent hang does. null (no poll has ever completed yet, e.g.
        // fresh start) is treated as not-degraded to avoid false alarms during warm-up.
        const sessionStaleSec = Math.max(
            60,
            parseInt(process.env.SESSION_HEARTBEAT_STALE_SEC || '900', 10)
        );
        const sessionHeartbeatStale =
            stats.secondsSinceSessionHeartbeat !== null &&
            stats.secondsSinceSessionHeartbeat > sessionStaleSec;

        const stale = crawlHeartbeatStale || sessionHeartbeatStale;

        const response = NextResponse.json(
            {
                crawlerRunning: stats.crawlerRunning,
                crawlerStatus: stats.crawlerStatus,
                secondsSinceHeartbeat: stats.secondsSinceHeartbeat,
                secondsSinceSessionHeartbeat: stats.secondsSinceSessionHeartbeat,
                sessionWatchdogTrips: stats.sessionWatchdogTrips,
                sessionHeartbeatStale,
                scannerRunning: stats.scanner?.isRunning ?? false,
                scannerStatus: stats.scanner ? 'available' : 'unknown',
                bungieMaintenanceActive: stats.bungieMaintenanceActive,
                bungieMaintenanceUntil: stats.bungieMaintenanceUntil,
                bungieMaintenanceRemainingMs: stats.bungieMaintenanceRemainingMs,
                isVacuuming: stats.isVacuuming,
                dbQuiesceActive: stats.dbQuiesceActive,
                cleanupStatus: stats.cleanupStatus,
                cleanupStartedAt: stats.cleanupStartedAt,
                cleanupFinishedAt: stats.cleanupFinishedAt,
                snapshotGeneratedAt: stats.snapshotGeneratedAt,
                lastVacuumCompletedAt: stats.lastVacuumCompletedAt,
                status: stale ? 'degraded' : 'ok',
                timestamp: Date.now()
            },
            { status: stale ? 503 : 200 }
        );

        return stale ? withNoStore(response) : withCache(response, 5, 15);
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            const maintenance = getBungieMaintenanceStatus();
            const snapshot = readStatusSnapshot();
            const stats = snapshot?.data;

            return withNoStore(NextResponse.json({
                crawlerRunning: stats?.crawlerRunning ?? false,
                crawlerStatus: stats?.crawlerStatus ?? 'maintenance',
                secondsSinceHeartbeat: stats?.secondsSinceHeartbeat ?? null,
                secondsSinceSessionHeartbeat: stats?.secondsSinceSessionHeartbeat ?? null,
                sessionWatchdogTrips: stats?.sessionWatchdogTrips ?? 0,
                scannerRunning: stats?.scanner?.isRunning ?? false,
                scannerStatus: stats?.scanner ? 'snapshot' : 'maintenance',
                bungieMaintenanceActive: maintenance.active,
                bungieMaintenanceUntil: maintenance.until,
                bungieMaintenanceRemainingMs: maintenance.remainingMs,
                isVacuuming: maintenance.isVacuuming,
                dbQuiesceActive: maintenance.dbQuiesceActive,
                cleanupStatus: maintenance.cleanupStatus,
                cleanupStartedAt: maintenance.cleanupStartedAt,
                cleanupFinishedAt: maintenance.cleanupFinishedAt,
                snapshotGeneratedAt: snapshot?.snapshotGeneratedAt ?? maintenance.snapshotGeneratedAt,
                lastVacuumCompletedAt: maintenance.lastVacuumCompletedAt,
                maintenanceSnapshot: true,
                status: 'maintenance',
                timestamp: Date.now(),
            }));
        }

        console.error('[ERROR] Status query failed:', error);
        return withNoStore(NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        ));
    }
}
