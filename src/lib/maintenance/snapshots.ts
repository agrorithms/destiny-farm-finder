import { getAllRaidDefinitions } from '../bungie/manifest';
import { runLeaderboardRows, type LeaderboardResponseEntry } from '../cache/leaderboard-cache';
import { getStatusStats, getSystemStats, type StatusStats, type SystemStats } from '../system-stats';
import { readSnapshot, writeSnapshot } from './state';

export interface MaintenanceSnapshotEnvelope<T> {
    maintenanceSnapshot: true;
    snapshotGeneratedAt: number;
    data: T;
}

export interface LeaderboardSnapshot {
    mode: 'aggregate';
    hours: number;
    fullClearsOnly: boolean;
    raidKeys: string[];
    entries: LeaderboardResponseEntry[];
}

function buildEnvelope<T>(data: T): MaintenanceSnapshotEnvelope<T> {
    return {
        maintenanceSnapshot: true,
        snapshotGeneratedAt: Date.now(),
        data,
    };
}

// Reuses the live leaderboard runner so the snapshot carries the same shape
// (including competition ranks) as a normal response.
function buildLeaderboardSnapshot(hours: number = 4, limit: number = 50): LeaderboardSnapshot {
    const allRaids = getAllRaidDefinitions();
    return {
        mode: 'aggregate',
        hours,
        fullClearsOnly: true,
        raidKeys: Object.keys(allRaids),
        entries: runLeaderboardRows(hours, [], limit),
    };
}

export function generateMaintenanceSnapshots(): void {
    // The public status snapshot never needs the DB totals, so build it from the
    // lean status stats (no COUNT(*) scans). The admin-stats snapshot keeps the
    // full stats since the admin dashboard renders the totals.
    const status = getStatusStats();
    const adminStats = getSystemStats();
    const leaderboard = buildLeaderboardSnapshot();

    writeSnapshot('status', buildEnvelope(status));
    writeSnapshot('admin-stats', buildEnvelope(adminStats));
    writeSnapshot('leaderboard', buildEnvelope(leaderboard));
}

export function readStatusSnapshot(): MaintenanceSnapshotEnvelope<StatusStats> | null {
    return readSnapshot<MaintenanceSnapshotEnvelope<StatusStats>>('status');
}

export function readAdminStatsSnapshot(): MaintenanceSnapshotEnvelope<SystemStats> | null {
    return readSnapshot<MaintenanceSnapshotEnvelope<SystemStats>>('admin-stats');
}

export function readLeaderboardSnapshot(): MaintenanceSnapshotEnvelope<LeaderboardSnapshot> | null {
    return readSnapshot<MaintenanceSnapshotEnvelope<LeaderboardSnapshot>>('leaderboard');
}
