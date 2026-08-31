import { getDbStats, getCrawlerStatus } from './db/queries';
import { getDb } from './db';
import { getBungieMaintenanceStatus } from './bungie/maintenance';

export interface ScannerStats {
    isRunning: boolean;
    currentInstanceId: string;
    totalScanned: number;
    totalRaidsFound: number;
    raidHitRate: string;
    uptimeSeconds: number;
    secondsSinceUpdate: number;
}

export interface SystemStats {
    crawlerRunning: boolean;
    crawlerStatus: string;
    lastHeartbeat: string | null;
    secondsSinceHeartbeat: number | null;
    secondsSinceSessionHeartbeat: number | null;
    sessionWatchdogTrips: number;
    bungieMaintenanceActive: boolean;
    bungieMaintenanceUntil: number | null;
    bungieMaintenanceRemainingMs: number;
    isVacuuming: boolean;
    dbQuiesceActive: boolean;
    cleanupStatus: string;
    cleanupStartedAt: number | null;
    cleanupFinishedAt: number | null;
    snapshotGeneratedAt: number | null;
    lastVacuumCompletedAt: number | null;
    scanner: ScannerStats | null;
    database: {
        totalPlayers: number;
        totalPGCRs: number;
        totalPGCRPlayers: number;
        activeSessions: number;
        oldestPGCR: string | null;
        newestPGCR: string | null;
    };
}

/**
 * Status fields without the database totals. `getDbStats()` runs four unfiltered
 * COUNT(*) scans over the (large) DB and synchronously blocks the event loop; the
 * public `/api/status` hot path never uses the totals, so it reads this leaner
 * shape instead. See getStatusStats below.
 */
export type StatusStats = Omit<SystemStats, 'database'>;

export function getStatusStats(): StatusStats {
    const crawlerStatus = getCrawlerStatus();
    const bungieMaintenance = getBungieMaintenanceStatus();

    const db = getDb();
    const scannerStatsRow = db.prepare(
        "SELECT value, updated_at FROM crawler_state WHERE key = 'scanner_stats'"
    ).get() as { value: string; updated_at: number } | undefined;

    let scannerStats: ScannerStats | null = null;
    if (scannerStatsRow) {
        try {
            const parsed = JSON.parse(scannerStatsRow.value) as Omit<ScannerStats, 'isRunning' | 'secondsSinceUpdate'>;
            const secondsSinceUpdate = Math.floor(Date.now() / 1000) - scannerStatsRow.updated_at;
            scannerStats = {
                ...parsed,
                isRunning: secondsSinceUpdate < 60,
                secondsSinceUpdate,
            };
        } catch {
            scannerStats = null;
        }
    }

    return {
        crawlerRunning: crawlerStatus.isRunning,
        crawlerStatus: crawlerStatus.status,
        lastHeartbeat: crawlerStatus.lastHeartbeat,
        secondsSinceHeartbeat: crawlerStatus.secondsSinceHeartbeat,
        secondsSinceSessionHeartbeat: crawlerStatus.secondsSinceSessionHeartbeat,
        sessionWatchdogTrips: crawlerStatus.sessionWatchdogTrips,
        bungieMaintenanceActive: bungieMaintenance.active,
        bungieMaintenanceUntil: bungieMaintenance.until,
        bungieMaintenanceRemainingMs: bungieMaintenance.remainingMs,
        isVacuuming: bungieMaintenance.isVacuuming,
        dbQuiesceActive: bungieMaintenance.dbQuiesceActive,
        cleanupStatus: bungieMaintenance.cleanupStatus,
        cleanupStartedAt: bungieMaintenance.cleanupStartedAt,
        cleanupFinishedAt: bungieMaintenance.cleanupFinishedAt,
        snapshotGeneratedAt: bungieMaintenance.snapshotGeneratedAt,
        lastVacuumCompletedAt: bungieMaintenance.lastVacuumCompletedAt,
        scanner: scannerStats,
    };
}

export function getSystemStats(): SystemStats {
    return {
        ...getStatusStats(),
        database: getDbStats(),
    };
}
