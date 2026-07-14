'use client';

import { useSyncExternalStore } from 'react';

// Single shared poller for /api/live-stats: however many components subscribe
// (StatsBar, FooterStatus, BungieMaintenanceAlert), the tab makes one request per
// interval. Polling pauses entirely while the tab is hidden and resumes with an
// immediate fetch when it becomes visible again.

export interface LiveStats {
    live: boolean;
    secondsSinceHeartbeat: number | null;
    fullClears24h: number;
    activeRaidSessions: number;
    bungieMaintenanceActive?: boolean;
    dbQuiesceActive?: boolean;
    maintenance?: boolean;
}

export interface LiveStatsSnapshot {
    stats: LiveStats | null;
    fetchedAt: Date | null;
}

export const LIVE_STATS_POLL_INTERVAL_MS = 30000;

const EMPTY_SNAPSHOT: LiveStatsSnapshot = { stats: null, fetchedAt: null };

let snapshot: LiveStatsSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function emit() {
    for (const listener of listeners) {
        listener();
    }
}

async function fetchStats() {
    try {
        const res = await fetch('/api/live-stats');
        const data: LiveStats = await res.json();
        snapshot = { stats: data, fetchedAt: new Date() };
        emit();
    } catch (err) {
        console.error('Failed to fetch live stats:', err);
    }
}

function startPolling() {
    if (intervalId !== null || document.hidden) {
        return;
    }
    fetchStats();
    intervalId = setInterval(fetchStats, LIVE_STATS_POLL_INTERVAL_MS);
}

function stopPolling() {
    if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

function handleVisibilityChange() {
    if (document.hidden) {
        stopPolling();
    } else if (listeners.size > 0) {
        startPolling();
    }
}

function subscribe(listener: () => void) {
    if (listeners.size === 0) {
        document.addEventListener('visibilitychange', handleVisibilityChange);
        startPolling();
    }
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            stopPolling();
        }
    };
}

/** Latest live stats and when this tab fetched them; null until the first response. */
export function useLiveStats(): LiveStatsSnapshot {
    return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY_SNAPSHOT);
}
