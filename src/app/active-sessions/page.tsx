'use client';

import { useEffect, useState, useCallback } from 'react';
import ActiveSessionCard from '@/components/ActiveSessionCard';
import RaidMultiSelect from '@/components/RaidMultiSelect';
import { useRaidFilter } from '@/hooks/useRaidFilter';
import { useReportPageLiveStatus } from '@/hooks/usePageLiveStatus';

interface PartyMember {
    membershipId: string;
    membershipType?: number;
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

interface RaidOption {
    key: string;
    name: string;
}

const AVAILABLE_RAIDS: RaidOption[] = [
    { key: 'pantheon_insurrection_prime_revolutionary', name: "Pantheon: Insurrection Prime Revolutionary" },
    { key: 'pantheon_morgeth_surpassing', name: 'Pantheon: Morgeth Surpassing' },
    { key: 'pantheon_calus_resplendent', name: 'Pantheon: Calus Resplendent' },
    { key: 'the_desert_perpetual', name: 'The Desert Perpetual' },
    { key: 'salvations_edge', name: "Salvation's Edge" },
    { key: 'crotas_end', name: "Crota's End" },
    { key: 'root_of_nightmares', name: 'Root of Nightmares' },
    { key: 'kings_fall', name: "King's Fall" },
    { key: 'vow_of_the_disciple', name: 'Vow of the Disciple' },
    { key: 'vault_of_glass', name: 'Vault of Glass' },
    { key: 'deep_stone_crypt', name: 'Deep Stone Crypt' },
    { key: 'garden_of_salvation', name: 'Garden of Salvation' },
    { key: 'last_wish', name: 'Last Wish' },
];

export default function ActiveSessionsPage() {
    const [sessions, setSessions] = useState<ActiveSession[]>([]);
    const [selectedRaids, setSelectedRaids] = useRaidFilter();
    const [loading, setLoading] = useState(true);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [maintenanceMessage, setMaintenanceMessage] = useState<string | null>(null);

    const fetchSessions = useCallback(async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/active-sessions?limit=600');
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            const data = await response.json();
            setSessions(data.sessions || []);
            setMaintenanceMessage(data.maintenance ? data.message || 'Database maintenance is in progress.' : null);
            setLastUpdated(new Date());
        } catch (error) {
            console.error('Failed to fetch active sessions:', error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSessions();
    }, [fetchSessions]);

    // Auto-refresh every 30 seconds
    useEffect(() => {
        const interval = setInterval(fetchSessions, 30000);
        return () => clearInterval(interval);
    }, [fetchSessions]);

    // Surface data freshness in the nav stats strip
    useReportPageLiveStatus(lastUpdated, 30);

    // Filter sessions by selected raids (empty = all raids)
    const filteredSessions = selectedRaids.length === 0
        ? sessions
        : sessions.filter((s) => selectedRaids.includes(s.raidKey));

    // Group filtered sessions by raid name
    const sessionsByRaid = new Map<string, ActiveSession[]>();
    for (const session of filteredSessions) {
        const raidName = session.raidName || 'Unknown Raid';
        if (!sessionsByRaid.has(raidName)) {
            sessionsByRaid.set(raidName, []);
        }
        sessionsByRaid.get(raidName)!.push(session);
    }

    // Sort raid groups by session count (most active first)
    const sortedRaidGroups = [...sessionsByRaid.entries()].sort(
        (a, b) => b[1].length - a[1].length
    );

    return (
        <div className="max-w-7xl mx-auto px-4 py-8">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-3xl font-bold ui-text-primary">Active Raid Sessions</h1>
            </div>

            {maintenanceMessage && (
                <div className="ui-card p-4 mb-6 text-sm text-red-700 dark:text-red-400">
                    {maintenanceMessage}
                </div>
            )}

            {/* Controls Card */}
            <div className="ui-card p-4 mb-6">
                <div className="flex flex-wrap items-end gap-4">
                    <div>
                        <label className="block text-xs ui-text-muted mb-1">Raid</label>
                        <RaidMultiSelect
                            raids={AVAILABLE_RAIDS}
                            selected={selectedRaids}
                            onChange={setSelectedRaids}
                        />
                    </div>

                    <div>
                        <button
                            onClick={fetchSessions}
                            disabled={loading}
                            className="px-4 py-2 text-sm rounded-lg ui-btn-primary disabled:opacity-50"
                        >
                            {loading ? 'Loading...' : 'Refresh'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Loading State */}
            {loading && sessions.length === 0 && (
                <div className="space-y-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="h-32 ui-skeleton rounded-lg animate-pulse" />
                    ))}
                </div>
            )}

            {/* Empty State */}
            {!loading && filteredSessions.length === 0 && !maintenanceMessage && (
                <div className="ui-card p-4">
                    <div className="text-center py-12 ui-text-secondary">
                        <p className="text-lg">No active raid sessions found</p>
                        <p className="text-sm mt-1">
                            {selectedRaids.length > 0
                                ? 'Try selecting different raids or wait for new sessions'
                                : 'Sessions will appear here when players are detected in raids'}
                        </p>
                    </div>
                </div>
            )}

            {/* Session Groups */}
            {sortedRaidGroups.map(([raidName, raidSessions]) => (
                <div key={raidName} className="mb-8">
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-xl font-bold ui-text-primary">{raidName}</h2>
                        <span className="text-sm ui-text-muted">
                            {raidSessions.length} {raidSessions.length === 1 ? 'session' : 'sessions'}
                        </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {raidSessions.map((session, index) => (
                            <ActiveSessionCard
                                key={`${session.membershipId}-${index}`}
                                session={session}
                            />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}
