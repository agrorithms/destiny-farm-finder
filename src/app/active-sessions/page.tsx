'use client';

import { useEffect, useState, useCallback } from 'react';
import StatsBar from '@/components/StatsBar';
import RaidSelector from '@/components/RaidSelector';
import ActiveSessionCard from '@/components/ActiveSessionCard';

interface PartyMember {
    membershipId: string;
    displayName: string;
    status: number;
}

interface ActiveSession {
    membershipId: string;
    displayName: string;
    activityHash: number;
    raidKey: string;
    raidName: string;
    startedAt: string;
    playerCount: number;
    partyMembers: PartyMember[];
}

export default function ActiveSessionsPage() {
    const [raidKey, setRaidKey] = useState<string>('all');
    const [sessions, setSessions] = useState<ActiveSession[]>([]);
    const [loading, setLoading] = useState(true);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

    const fetchSessions = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({
                limit: '50',
            });

            if (raidKey !== 'all') {
                params.set('raid', raidKey);
            }

            const res = await fetch(`/api/active-sessions?${params.toString()}`);
            const data = await res.json();

            if (data.sessions) {
                setSessions(data.sessions);
            } else {
                setSessions([]);
            }

            setLastUpdated(new Date());
        } catch (err) {
            console.error('Failed to fetch active sessions:', err);
            setSessions([]);
        } finally {
            setLoading(false);
        }
    }, [raidKey]);

    // Fetch on mount and when filter changes
    useEffect(() => {
        fetchSessions();
    }, [fetchSessions]);

    // Auto-refresh every 30 seconds
    useEffect(() => {
        const interval = setInterval(fetchSessions, 30000);
        return () => clearInterval(interval);
    }, [fetchSessions]);

    // Group sessions by raid
    const sessionsByRaid = sessions.reduce<Record<string, ActiveSession[]>>(
        (acc, session) => {
            const key = session.raidName || 'Unknown';
            if (!acc[key]) acc[key] = [];
            acc[key].push(session);
            return acc;
        },
        {}
    );

    return (
        <div className="space-y-6">
            <StatsBar />

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <h1 className="text-2xl font-bold">Active Raid Sessions</h1>
                {lastUpdated && (
                    <span className="text-xs text-gray-500">
                        Last updated: {lastUpdated.toLocaleTimeString()}
                    </span>
                )}
            </div>

            <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
                    <div className="flex flex-col gap-1">
                        <label className="text-sm font-medium text-gray-300">Raid</label>
                        <RaidSelector value={raidKey} onChange={setRaidKey} includeAll={true} />
                    </div>
                    <button
                        onClick={fetchSessions}
                        disabled={loading}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:text-gray-400 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        {loading ? 'Loading...' : 'Refresh'}
                    </button>
                </div>
            </div>

            {loading && sessions.length === 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div
                            key={i}
                            className="h-48 bg-gray-800 rounded-lg animate-pulse"
                        />
                    ))}
                </div>
            ) : sessions.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                    <p className="text-lg">No active raid sessions found</p>
                    <p className="text-sm mt-2">
                        Make sure the crawler is running and has discovered active players.
                        Sessions are detected by polling tracked players for their current activity.
                    </p>
                </div>
            ) : raidKey === 'all' ? (
                // Grouped view when showing all raids
                <div className="space-y-8">
                    {Object.entries(sessionsByRaid)
                        .sort(([, a], [, b]) => b.length - a.length)
                        .map(([raidName, raidSessions]) => (
                            <div key={raidName}>
                                <div className="flex items-center justify-between mb-3">
                                    <h2 className="text-lg font-bold text-gray-200">
                                        {raidName}
                                    </h2>
                                    <span className="text-sm text-gray-500">
                                        {raidSessions.length}{' '}
                                        {raidSessions.length === 1 ? 'session' : 'sessions'}
                                    </span>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {raidSessions.map((session, i) => (
                                        <ActiveSessionCard key={`${session.membershipId}-${i}`} session={session} />
                                    ))}
                                </div>
                            </div>
                        ))}
                </div>
            ) : (
                // Flat view when filtering to a specific raid
                <div>
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-lg font-bold text-gray-200">
                            {sessions[0]?.raidName || raidKey}
                        </h2>
                        <span className="text-sm text-gray-500">
                            {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
                        </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {sessions.map((session, i) => (
                            <ActiveSessionCard key={`${session.membershipId}-${i}`} session={session} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
