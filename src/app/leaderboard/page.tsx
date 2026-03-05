'use client';

import { useEffect, useState, useCallback } from 'react';
import StatsBar from '@/components/StatsBar';
import RaidSelector from '@/components/RaidSelector';
import TimeSlider from '@/components/TimeSlider';
import LeaderboardTable from '@/components/LeaderboardTable';

interface LeaderboardEntry {
    membershipId: string;
    membershipType: number;
    displayName: string;
    bungieGlobalDisplayName?: string;
    completions: number;
    raidName?: string;
}

export default function LeaderboardPage() {
    const [raidKey, setRaidKey] = useState<string>('all');
    const [hoursBack, setHoursBack] = useState<number>(4);
    const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

    const fetchLeaderboard = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({
                hours: String(hoursBack),
                limit: '100',
                fullClearsOnly: 'true',
            });

            if (raidKey !== 'all') {
                params.set('raid', raidKey);
            }

            const res = await fetch(`/api/leaderboard?${params.toString()}`);
            const data = await res.json();

            if (data.entries) {
                setEntries(data.entries);
            } else {
                setEntries([]);
            }

            setLastUpdated(new Date());
        } catch (err) {
            console.error('Failed to fetch leaderboard:', err);
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, [raidKey, hoursBack]);

    // Fetch on mount and when filters change
    useEffect(() => {
        fetchLeaderboard();
    }, [fetchLeaderboard]);

    // Auto-refresh every 60 seconds
    useEffect(() => {
        const interval = setInterval(fetchLeaderboard, 60000);
        return () => clearInterval(interval);
    }, [fetchLeaderboard]);

    return (
        <div className="space-y-6">
            <StatsBar />

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <h1 className="text-2xl font-bold">Raid Leaderboard</h1>
                {lastUpdated && (
                    <span className="text-xs text-gray-500">
                        Last updated: {lastUpdated.toLocaleTimeString()}
                    </span>
                )}
            </div>

            <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-4">
                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
                    <div className="flex flex-col gap-1">
                        <label className="text-sm font-medium text-gray-300">Raid</label>
                        <RaidSelector value={raidKey} onChange={setRaidKey} includeAll={true} />
                    </div>
                    <div className="flex-1 min-w-[200px]">
                        <TimeSlider
                            value={hoursBack}
                            onChange={setHoursBack}
                            min={1}
                            max={8}
                            step={0.5}
                        />
                    </div>
                    <button
                        onClick={fetchLeaderboard}
                        disabled={loading}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:text-gray-400 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        {loading ? 'Loading...' : 'Refresh'}
                    </button>
                </div>
            </div>

            <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
                    <h2 className="text-sm font-medium text-gray-300">
                        {raidKey === 'all' ? 'All Raids' : entries.length > 0 ? entries[0].raidName || raidKey : raidKey}
                        {' '}&mdash; Last {hoursBack} {hoursBack === 1 ? 'hour' : 'hours'}
                    </h2>
                    <span className="text-xs text-gray-500">
                        {entries.length} {entries.length === 1 ? 'player' : 'players'}
                    </span>
                </div>
                <LeaderboardTable
                    entries={entries}
                    loading={loading}
                    raidKey={raidKey}
                />
            </div>
        </div>
    );
}
