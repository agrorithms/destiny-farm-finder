'use client';

import { useEffect, useRef, useState } from 'react';
import { usePageLiveStatus } from '@/hooks/usePageLiveStatus';
import { useLiveStats, LIVE_STATS_POLL_INTERVAL_MS } from '@/hooks/useLiveStats';

function formatSecondsAgo(seconds: number | null): string {
    if (seconds === null) return 'never';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
}

function formatSecondsShort(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
}

/** Stat value that flashes once each time `flashStamp` is bumped. */
function StatNumber({ value, flashStamp }: { value: number; flashStamp: number }) {
    return (
        <span
            key={flashStamp}
            className={`font-mono font-bold ui-text-primary ${flashStamp > 0 ? 'stat-flash' : ''}`}
        >
            {value.toLocaleString()}
        </span>
    );
}

/**
 * Live status strip rendered at the bottom of the sticky nav (global, all pages).
 * Pages that auto-refresh report their data freshness via useReportPageLiveStatus;
 * otherwise the ticker reflects this strip's own poll.
 */
export default function StatsBar() {
    const pageStatus = usePageLiveStatus();
    const { stats, fetchedAt: statsFetchedAt } = useLiveStats();
    const [flashStamps, setFlashStamps] = useState({ clears: 0, sessions: 0 });
    const [secondsAgo, setSecondsAgo] = useState(0);
    const prevCountsRef = useRef<{ clears: number; sessions: number } | null>(null);

    useEffect(() => {
        if (!stats) {
            return;
        }
        const prev = prevCountsRef.current;
        if (prev) {
            setFlashStamps((stamps) => ({
                clears: prev.clears !== stats.fullClears24h ? stamps.clears + 1 : stamps.clears,
                sessions: prev.sessions !== stats.activeRaidSessions ? stamps.sessions + 1 : stamps.sessions,
            }));
        }
        prevCountsRef.current = { clears: stats.fullClears24h, sessions: stats.activeRaidSessions };
    }, [stats]);

    // Ticking "Updated Xs ago". A new updatedAt is corrected on the next 1s tick.
    const updatedAtMs = (pageStatus?.lastUpdated ?? statsFetchedAt)?.getTime() ?? null;
    useEffect(() => {
        if (updatedAtMs === null) {
            return;
        }
        const update = () => setSecondsAgo(Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000)));
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [updatedAtMs]);

    const refreshSec = pageStatus?.refreshIntervalSec ?? LIVE_STATS_POLL_INTERVAL_MS / 1000;

    const liveLabel = stats?.maintenance
        ? 'Maintenance'
        : stats?.live
            ? 'Live'
            : 'Updates paused';
    const liveTitle = stats?.maintenance
        ? 'Database maintenance is in progress'
        : `Last data heartbeat: ${formatSecondsAgo(stats?.secondsSinceHeartbeat ?? null)}`;

    return (
        <div className="border-t border-[var(--ui-nav-border)]">
            <div className="max-w-7xl mx-auto px-4 py-1.5 flex items-center gap-x-2 sm:gap-x-3 text-xs ui-text-muted whitespace-nowrap">
                {!stats ? (
                    <div className="h-4 w-44 ui-skeleton rounded animate-pulse" />
                ) : (
                    <>
                        <div className="flex items-center gap-1.5" title={liveTitle}>
                            <span
                                className={`w-2 h-2 rounded-full ${stats.live
                                    ? 'bg-green-500 animate-pulse'
                                    : 'bg-[var(--ui-text-subtle)]'
                                    }`}
                            />
                            <span className={stats.live ? 'ui-text-secondary font-medium' : ''}>{liveLabel}</span>
                        </div>
                        <span className="ui-text-subtle" aria-hidden="true">·</span>
                        <div className="flex items-center gap-1">
                            <StatNumber value={stats.fullClears24h} flashStamp={flashStamps.clears} />
                            <span className="hidden sm:inline">full clears · last 24h</span>
                            <span className="sm:hidden">clears</span>
                        </div>
                        <span className="ui-text-subtle" aria-hidden="true">·</span>
                        <div className="flex items-center gap-1">
                            <StatNumber value={stats.activeRaidSessions} flashStamp={flashStamps.sessions} />
                            <span className="hidden sm:inline">
                                {stats.activeRaidSessions === 1 ? 'fireteam' : 'fireteams'} raiding now
                            </span>
                            <span className="sm:hidden">raiding</span>
                        </div>
                        {updatedAtMs !== null && (
                            <>
                                <span className="ui-text-subtle" aria-hidden="true">·</span>
                                <span title={`Auto-refreshes every ${refreshSec}s`}>
                                    <span className="hidden sm:inline">Updated {formatSecondsAgo(secondsAgo)}</span>
                                    <span className="sm:hidden">{formatSecondsShort(secondsAgo)}</span>
                                </span>
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
