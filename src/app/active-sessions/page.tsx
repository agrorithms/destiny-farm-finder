'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import ActiveSessionCard from '@/components/ActiveSessionCard';
import RaidMultiSelect from '@/components/RaidMultiSelect';
import { useRaidFilter } from '@/hooks/useRaidFilter';
import { useReportPageLiveStatus } from '@/hooks/usePageLiveStatus';
import { usePolledFetch } from '@/hooks/usePolledFetch';
import { diffSessions, viewTransitionNameFor, type DisplayEntry } from '@/lib/active-session/diff';

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

interface ActiveSessionsResponse {
    sessions?: ActiveSession[];
    maintenance?: boolean;
    message?: string;
}

interface RaidOption {
    key: string;
    name: string;
}

const AVAILABLE_RAIDS: RaidOption[] = [
    //{ key: 'pantheon_insurrection_prime_revolutionary', name: "Pantheon: Insurrection Prime Revolutionary" },
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

const RAID_ORDER = new Map(AVAILABLE_RAIDS.map((raid, index) => [raid.key, index]));

// Ended cards leave in stages, offset from the poll tick so removals don't pile
// onto the same reflow as inserts: dimmed hold, then a CSS opacity fade, then one
// batched view transition closes the gap. Fade duration must match .session-fade-out.
const ENDED_HOLD_MS = 5000;
const ENDED_FADE_MS = 1500;

/** Animate the update with the View Transitions API where available; fall back to an instant update. */
function applyWithTransition(apply: () => void, animate: boolean) {
    const doc = document as Document & {
        startViewTransition?: (callback: () => void) => { ready?: Promise<void>; finished?: Promise<void> };
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // startViewTransition throws InvalidStateError when the document is hidden
    // (a poll firing in a background tab) — and animating there is pointless anyway.
    if (!animate || !doc.startViewTransition || reduceMotion || document.visibilityState === 'hidden') {
        apply();
        return;
    }
    try {
        const transition = doc.startViewTransition(() => {
            flushSync(apply);
        });
        // A transition preempted by the next update rejects these; expected, not an error.
        transition.ready?.catch(() => {});
        transition.finished?.catch(() => {});
    } catch {
        // Synchronous throw means the callback never ran — commit without animation.
        apply();
    }
}

export default function ActiveSessionsPage() {
    const [selectedRaids, setSelectedRaids] = useRaidFilter();
    const [display, setDisplay] = useState<DisplayEntry<ActiveSession>[]>([]);
    const [fadingKeys, setFadingKeys] = useState<Set<string>>(new Set());
    const prevEntriesRef = useRef<Map<string, DisplayEntry<ActiveSession>> | null>(null);
    const lastDataRef = useRef<ActiveSessionsResponse | null>(null);
    const signatureRef = useRef('');
    const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    // Stage the exit of a batch of sessions that ended on the same poll: start the
    // CSS fade after the hold, then remove them together in one view transition.
    // A session that revives mid-stage (manual refresh) has ended=false again, so
    // the fade class stops applying and the removal filter skips it.
    const scheduleEndedRemoval = useCallback((keys: string[]) => {
        const batch = new Set(keys);
        const fadeTimer = setTimeout(() => {
            timersRef.current.delete(fadeTimer);
            setFadingKeys((current) => new Set([...current, ...batch]));
        }, ENDED_HOLD_MS);
        const removeTimer = setTimeout(() => {
            timersRef.current.delete(removeTimer);
            setFadingKeys((current) => {
                const next = new Set(current);
                for (const key of batch) next.delete(key);
                return next;
            });
            applyWithTransition(() => {
                setDisplay((current) => current.filter((entry) => !(entry.ended && batch.has(entry.key))));
            }, true);
        }, ENDED_HOLD_MS + ENDED_FADE_MS);
        timersRef.current.add(fadeTimer);
        timersRef.current.add(removeTimer);
    }, []);

    useEffect(() => {
        const timers = timersRef.current;
        return () => {
            for (const timer of timers) clearTimeout(timer);
        };
    }, []);

    const { data, loading, lastUpdated, refresh } = usePolledFetch<ActiveSessionsResponse>(
        '/api/active-sessions?limit=200',
        30000
    );

    const maintenanceMessage = data?.maintenance
        ? data.message || 'Database maintenance is in progress.'
        : null;

    useEffect(() => {
        // Each poll produces a fresh data object; skip re-runs for one we already
        // committed (dev StrictMode double-fires effects, stacking transitions).
        if (!data || data === lastDataRef.current) return;
        lastDataRef.current = data;

        let next: DisplayEntry<ActiveSession>[];
        if (data.maintenance) {
            // Data is unavailable, not ended — clear without the "Ended" hold, and
            // reset the baseline so recovery renders like a first load (no NEW flashes).
            prevEntriesRef.current = null;
            next = [];
        } else {
            next = diffSessions(data.sessions || [], prevEntriesRef.current);
            prevEntriesRef.current = new Map(next.map((entry) => [entry.key, entry]));
        }

        // Animate only when the visible structure changed (cards added/removed or
        // badges flipped); a poll where nothing moved commits instantly instead of
        // cross-fading every card each cycle.
        const signature = next
            .map((entry) => `${entry.key}|${entry.isNew ? 1 : 0}|${entry.ended ? 1 : 0}`)
            .sort()
            .join(';');
        const structureChanged = signature !== signatureRef.current;
        signatureRef.current = signature;
        applyWithTransition(() => setDisplay(next), structureChanged);

        const endedKeys = next.filter((entry) => entry.ended).map((entry) => entry.key);
        if (endedKeys.length > 0) {
            scheduleEndedRemoval(endedKeys);
        }
    }, [data, scheduleEndedRemoval]);

    // Surface data freshness in the nav stats strip
    useReportPageLiveStatus(lastUpdated, 30);

    // Filter sessions by selected raids (empty = all raids)
    const filteredEntries = selectedRaids.length === 0
        ? display
        : display.filter((entry) => selectedRaids.includes(entry.session.raidKey));

    // Group by raid name, ordered canonically (not by count) so sections never
    // leapfrog between refreshes. Within a group, newest-first by startedAt —
    // stable across polls since a session's start time never changes.
    const entriesByRaid = new Map<string, DisplayEntry<ActiveSession>[]>();
    for (const entry of filteredEntries) {
        const raidName = entry.session.raidName || 'Unknown Raid';
        if (!entriesByRaid.has(raidName)) {
            entriesByRaid.set(raidName, []);
        }
        entriesByRaid.get(raidName)!.push(entry);
    }

    const sortedRaidGroups = [...entriesByRaid.entries()].sort((a, b) => {
        const orderA = RAID_ORDER.get(a[1][0].session.raidKey) ?? AVAILABLE_RAIDS.length;
        const orderB = RAID_ORDER.get(b[1][0].session.raidKey) ?? AVAILABLE_RAIDS.length;
        if (orderA !== orderB) return orderA - orderB;
        return a[0].localeCompare(b[0]);
    });
    for (const [, groupEntries] of sortedRaidGroups) {
        groupEntries.sort((a, b) => Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt));
    }

    const initialLoading = loading && !data;

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
                            onClick={refresh}
                            disabled={loading}
                            className="px-4 py-2 text-sm rounded-lg ui-btn-primary disabled:opacity-50"
                        >
                            {loading ? 'Loading...' : 'Refresh'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Loading State */}
            {initialLoading && (
                <div className="space-y-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="h-32 ui-skeleton rounded-lg animate-pulse" />
                    ))}
                </div>
            )}

            {/* Empty State */}
            {!initialLoading && filteredEntries.length === 0 && !maintenanceMessage && (
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
            {sortedRaidGroups.map(([raidName, groupEntries]) => {
                const activeCount = groupEntries.filter((entry) => !entry.ended).length;
                return (
                    <div key={raidName} className="mb-8">
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="text-xl font-bold ui-text-primary">{raidName}</h2>
                            <span className="text-sm ui-text-muted">
                                {activeCount} {activeCount === 1 ? 'session' : 'sessions'}
                            </span>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                            {groupEntries.map((entry) => {
                                const fading = entry.ended && fadingKeys.has(entry.key);
                                return (
                                    <div
                                        key={entry.key}
                                        className={`${entry.isNew ? 'row-flash' : ''} ${fading ? 'session-fade-out' : entry.ended ? 'opacity-50' : ''}`}
                                        style={{ viewTransitionName: viewTransitionNameFor(entry.key) }}
                                    >
                                        <ActiveSessionCard
                                            session={entry.session}
                                            badge={entry.isNew ? 'new' : entry.ended ? 'ended' : undefined}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
