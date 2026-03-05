'use client';

import { useEffect, useState } from 'react';

interface Stats {
    crawlerRunning: boolean;
    crawlerStatus: string;
    lastHeartbeat: string | null;
    secondsSinceHeartbeat: number | null;
    database: {
        totalPlayers: number;
        totalPGCRs: number;
        totalPGCRPlayers: number;
        activeSessions: number;
        oldestPGCR: string | null;
        newestPGCR: string | null;
    };
}

function formatSecondsAgo(seconds: number | null): string {
    if (seconds === null) return 'never';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
}

export default function StatsBar() {
    const [stats, setStats] = useState<Stats | null>(null);

    useEffect(() => {
        const fetchStats = () => {
            fetch('/api/stats')
                .then((res) => res.json())
                .then(setStats)
                .catch((err) => console.error('Failed to fetch stats:', err));
        };

        fetchStats();
        const interval = setInterval(fetchStats, 15000); // Refresh every 15s
        return () => clearInterval(interval);
    }, []);

    if (!stats) {
        return (
            <div className="h-8 bg-gray-800 rounded animate-pulse" />
        );
    }

    return (
        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-400 bg-gray-800/50 border border-gray-700 rounded-lg px-4 py-2">
            <div className="flex items-center gap-1.5">
                <div
                    className={`w-2 h-2 rounded-full ${stats.crawlerRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'
                        }`}
                />
                <span>
                    Crawler: {stats.crawlerRunning ? 'Running' : stats.crawlerStatus === 'never_started' ? 'Never Started' : 'Stopped'}
                </span>
                {stats.secondsSinceHeartbeat !== null && (
                    <span className="text-gray-600">
                        (heartbeat {formatSecondsAgo(stats.secondsSinceHeartbeat)})
                    </span>
                )}
            </div>
            <span className="text-gray-600">|</span>
            <span>Players: {stats.database.totalPlayers.toLocaleString()}</span>
            <span className="text-gray-600">|</span>
            <span>PGCRs: {stats.database.totalPGCRs.toLocaleString()}</span>
            <span className="text-gray-600">|</span>
            <span>Active Sessions: {stats.database.activeSessions}</span>
            {stats.database.newestPGCR && (
                <>
                    <span className="text-gray-600">|</span>
                    <span>
                        Latest PGCR: {new Date(stats.database.newestPGCR).toLocaleTimeString()}
                    </span>
                </>
            )}
        </div>
    );
}
