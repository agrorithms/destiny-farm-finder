'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import RaidMultiSelect from '@/components/RaidMultiSelect';
import LeaderboardTable from '@/components/LeaderboardTable';
import TimeSlider, { formatTimeRange } from '@/components/TimeSlider';
import { useRaidFilter } from '@/hooks/useRaidFilter';
import { useReportPageLiveStatus } from '@/hooks/usePageLiveStatus';
import { useViewMode, useTimeRange, useLeaderboardSize, usePlayersFilter, type PlayersFilter } from '@/hooks/useLeaderboardPrefs';

interface RaidOption {
    key: string;
    name: string;
}

interface LeaderboardEntry {
    membershipId: string;
    membershipType: number;
    displayName: string;
    completions: number;
    /** Competition rank from the server (ties share a rank number). */
    rank: number;
    /** Rank change vs when the page was opened (positive = moved up). */
    rankDelta?: number;
    /** Entered the board mid-session and hasn't changed rank since. */
    isNew?: boolean;
    /** Fetch sequence number of the last time this row's rank/clears changed. */
    changeStamp?: number;
}

interface AggregateResponse {
    mode: 'aggregate';
    hours: number;
    fullClearsOnly: boolean;
    raidKeys: string[];
    entries: LeaderboardEntry[];
    maintenance?: boolean;
    snapshotGeneratedAt?: number;
}

interface IndividualResponse {
    mode: 'individual';
    hours: number;
    fullClearsOnly: boolean;
    raidKeys: string[];
    maintenance?: boolean;
    snapshotGeneratedAt?: number;
    leaderboards: Record<string, {
        raidKey: string;
        raidName: string;
        entries: LeaderboardEntry[];
    }>;
}

type LeaderboardResponse = AggregateResponse | IndividualResponse;

const AVAILABLE_RAIDS: RaidOption[] = [
    //pantheon insurrection prime and morgeth surpassing are not accurately showing fresh clears so will never return results
    { key: 'pantheon_insurrection_prime_revolutionary', name: "Pantheon: Insurrection Prime Revolutionary" },
    //{ key: 'pantheon_morgeth_surpassing', name: 'Pantheon: Morgeth Surpassing' },
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

const LEADERBOARD_SIZE_OPTIONS = [6, 12, 25, 50, 75, 100];

export default function LeaderboardPage() {
    const [selectedRaids, setSelectedRaids] = useRaidFilter();
    const [hours, setHours] = useTimeRange();
    const [mode, setMode] = useViewMode();
    const [leaderboardSize, setLeaderboardSize] = useLeaderboardSize();
    const [playersFilter, setPlayersFilter] = usePlayersFilter();
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState<LeaderboardResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const requestIdRef = useRef(0);
    const activeControllerRef = useRef<AbortController | null>(null);
    // Rank movement is measured against the first response seen for the current
    // filter combo ("since you opened this page"), not the previous refresh.
    const baselineRef = useRef<{ comboKey: string; ranks: Map<string, number> } | null>(null);
    const prevRowsRef = useRef<Map<string, { rank: number; completions: number; changeStamp?: number }>>(new Map());
    // Players who entered the board mid-session; they wear NEW until their rank first changes.
    const newEntrantsRef = useRef<Set<string>>(new Set());

    const annotateMovement = useCallback((result: LeaderboardResponse, comboKey: string, fetchSeq: number) => {
        const scopes: Array<[string, LeaderboardEntry[]]> = result.mode === 'aggregate'
            ? [['aggregate', result.entries]]
            : Object.values(result.leaderboards).map((lb) => [lb.raidKey, lb.entries] as [string, LeaderboardEntry[]]);

        if (baselineRef.current?.comboKey !== comboKey) {
            // Filters changed (or first load): reset and capture a fresh baseline.
            const ranks = new Map<string, number>();
            for (const [scope, entries] of scopes) {
                entries.forEach((entry) => ranks.set(`${scope}:${entry.membershipId}`, entry.rank));
            }
            baselineRef.current = { comboKey, ranks };
            newEntrantsRef.current = new Set();
            prevRowsRef.current = new Map(
                scopes.flatMap(([scope, entries]) => entries.map((entry): [string, { rank: number; completions: number }] => [
                    `${scope}:${entry.membershipId}`,
                    { rank: entry.rank, completions: entry.completions },
                ]))
            );
            return result;
        }

        const baseline = baselineRef.current.ranks;
        const newEntrants = newEntrantsRef.current;
        const prevRows = prevRowsRef.current;
        const nextRows = new Map<string, { rank: number; completions: number; changeStamp?: number }>();

        for (const [scope, entries] of scopes) {
            entries.forEach((entry) => {
                const key = `${scope}:${entry.membershipId}`;
                const rank = entry.rank;
                const baselineRank = baseline.get(key);
                if (baselineRank === undefined) {
                    // Mid-session entrant: NEW badge until their rank first changes.
                    baseline.set(key, rank);
                    newEntrants.add(key);
                    entry.isNew = true;
                } else if (baselineRank !== rank) {
                    entry.rankDelta = baselineRank - rank;
                    newEntrants.delete(key);
                } else if (newEntrants.has(key)) {
                    entry.isNew = true;
                }
                const prev = prevRows.get(key);
                // prev === undefined here means a mid-session entrant — flash their arrival.
                const changed = prev === undefined || prev.rank !== rank || prev.completions !== entry.completions;
                entry.changeStamp = changed ? fetchSeq : prev?.changeStamp;
                nextRows.set(key, { rank, completions: entry.completions, changeStamp: entry.changeStamp });
            });
        }

        prevRowsRef.current = nextRows;
        return result;
    }, []);

    const fetchLeaderboard = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        activeControllerRef.current?.abort();
        const controller = new AbortController();
        activeControllerRef.current = controller;

        setLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams({
                hours: hours.toString(),
                fullClearsOnly: 'true',
                mode,
                limit: leaderboardSize.toString(),
            });

            if (selectedRaids.length > 0) {
                params.set('raids', selectedRaids.join(','));
            }
            if (playersFilter === 'lowman') {
                params.set('maxPlayers', '3');
            } else if (playersFilter) {
                params.set('exactPlayers', playersFilter);
            }

            const response = await fetch(`/api/leaderboard?${params}`, {
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const result = await response.json();
            if (requestId !== requestIdRef.current) {
                return;
            }
            const comboKey = `${hours}|${mode}|${leaderboardSize}|${selectedRaids.join(',')}|${playersFilter}`;
            setData(annotateMovement(result, comboKey, requestId));
            setLastUpdated(new Date());
        } catch (err) {
            if ((err as Error).name === 'AbortError') {
                return;
            }
            if (requestId !== requestIdRef.current) {
                return;
            }
            setError((err as Error).message);
        } finally {
            if (requestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [selectedRaids, hours, mode, leaderboardSize, playersFilter, annotateMovement]);

    useEffect(() => {
        return () => activeControllerRef.current?.abort();
    }, []);

    useEffect(() => {
        fetchLeaderboard();
    }, [fetchLeaderboard]);

    // Auto-refresh every 60 seconds
    useEffect(() => {
        const interval = setInterval(fetchLeaderboard, 60000);
        return () => clearInterval(interval);
    }, [fetchLeaderboard]);

    // Surface data freshness in the nav stats strip
    useReportPageLiveStatus(lastUpdated, 60);

    // Build the raid filter description
    const raidFilterLabel = selectedRaids.length === 0 || selectedRaids.length === AVAILABLE_RAIDS.length
        ? 'All Raids'
        : selectedRaids.length === 1
            ? AVAILABLE_RAIDS.find((r) => r.key === selectedRaids[0])?.name || ''
            : `${selectedRaids.length} Raids`;

    return (
        <div className="max-w-7xl mx-auto px-4 py-8">
            <h1 className="text-3xl font-bold ui-text-primary mb-2">Raid Leaderboard</h1>
            <p className="ui-text-secondary mb-6">
                Top raiders by full clears in the last {formatTimeRange(hours)}
                {raidFilterLabel !== 'All Raids' && ` — ${raidFilterLabel}`}
            </p>

            {data?.maintenance && (
                <div className="ui-card p-4 mb-6 text-sm text-red-700 dark:text-red-400">
                    Database maintenance is in progress. Showing the last known leaderboard snapshot
                    {data.snapshotGeneratedAt ? ` from ${new Date(data.snapshotGeneratedAt).toLocaleString()}` : ''}.
                    Filters are temporarily frozen until maintenance completes.
                </div>
            )}

            {/* Controls + Time Range Card (combined) */}
            <div className="ui-card p-4 mb-6">
                {/* Top row: Raid filter, View toggle, Refresh */}
                <div className="flex flex-wrap items-end gap-4 mb-4">
                    {/* Raid Multi-Select */}
                    <div>
                        <label className="block text-xs ui-text-muted mb-1">Raids</label>
                        <RaidMultiSelect
                            raids={AVAILABLE_RAIDS}
                            selected={selectedRaids}
                            onChange={setSelectedRaids}
                        />
                    </div>

                    {/* View Mode Toggle */}
                    <div>
                        <label className="block text-xs ui-text-muted mb-1">View</label>
                        <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600">
                            <button
                                onClick={() => setMode('individual')}
                                className={`px-3 py-2 text-sm transition-colors ${mode === 'individual'
                                    ? 'ui-toggle-active'
                                    : 'ui-toggle-idle'
                                    }`}
                            >
                                Per Raid
                            </button>
                            <button
                                onClick={() => setMode('aggregate')}
                                className={`px-3 py-2 text-sm transition-colors ${mode === 'aggregate'
                                    ? 'ui-toggle-active'
                                    : 'ui-toggle-idle'
                                    }`}
                            >
                                Total Clears
                            </button>
                        </div>
                    </div>

                    {/* Players Filter */}
                    <div>
                        <label className="block text-xs ui-text-muted mb-1">Players</label>
                        <select
                            value={playersFilter}
                            onChange={(e) => setPlayersFilter(e.target.value as PlayersFilter)}
                            className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 ui-toggle-idle"
                        >
                            <option value="">All</option>
                            <option value="1">Solo</option>
                            <option value="2">Duo</option>
                            <option value="3">Trio</option>
                            <option value="lowman">Any Lowman</option>
                        </select>
                    </div>

                    {/* Leaderboard Size */}
                    <div>
                        <label className="block text-xs ui-text-muted mb-1">Rows</label>
                        <select
                            value={leaderboardSize}
                            onChange={(e) => setLeaderboardSize(parseInt(e.target.value, 10))}
                            className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 ui-toggle-idle"
                        >
                            {LEADERBOARD_SIZE_OPTIONS.map((size) => (
                                <option key={size} value={size}>
                                    {size}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Refresh Button */}
                    <div>
                        <button
                            onClick={fetchLeaderboard}
                            disabled={loading}
                            className="px-4 py-2 text-sm rounded-lg ui-btn-primary disabled:opacity-50"
                        >
                            {loading ? 'Loading...' : 'Refresh'}
                        </button>
                    </div>
                </div>

                <div className="border-t ui-divider pt-4">
                    <TimeSlider value={hours} onChange={setHours} />
                </div>
            </div>

            {/* Error State */}
            {error && (
                <div className="bg-red-100 border border-red-300 rounded-lg p-4 mb-6 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
                    Error loading leaderboard: {error}
                </div>
            )}

            {/* Aggregate Leaderboard */}
            {data && data.mode === 'aggregate' && (
                <div className="ui-card p-3 sm:p-4">
                    <LeaderboardTable
                        entries={(data as AggregateResponse).entries}
                        loading={loading && !data}
                        showRaidColumn={false}
                    />
                </div>
            )}

            {/* Individual Leaderboards */}
            {data && data.mode === 'individual' && (
                <>
                    {(() => {
                        const leaderboards = Object.values((data as IndividualResponse).leaderboards);
                        const count = leaderboards.length;

                        if (count === 0 && !loading) {
                            return (
                                <div className="ui-card p-3 sm:p-4">
                                    <div className="text-center py-12 ui-text-secondary">
                                        <p className="text-lg">No leaderboards found</p>
                                        <p className="text-sm mt-1">Try a different time range or refresh the leaderboard</p>
                                    </div>
                                </div>
                            );
                        }

                        let gridClass: string;
                        if (count === 1) {
                            gridClass = 'grid grid-cols-1';
                        } else if (count === 2) {
                            gridClass = 'grid grid-cols-1 md:grid-cols-2';
                        } else {
                            gridClass = 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3';
                        }

                        return (
                            <div className={`${gridClass} gap-4`}>
                                {leaderboards.map((lb) => (
                                    <div
                                        key={lb.raidKey}
                                        className="ui-card p-3 sm:p-4 min-w-0"
                                    >
                                        <LeaderboardTable
                                            entries={lb.entries}
                                            loading={loading && !data}
                                            title={lb.raidName}
                                            showRaidColumn={false}
                                        />
                                    </div>
                                ))}
                            </div>
                        );
                    })()}
                </>
            )}
        </div>
    );
}
