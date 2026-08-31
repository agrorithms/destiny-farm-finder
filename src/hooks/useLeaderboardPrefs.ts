'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_TIME_RANGE_HOURS, isTimeRangePreset } from '@/components/TimeSlider';

const VIEW_MODE_KEY = 'destiny-farm-finder-view-mode';
const TIME_RANGE_KEY = 'destiny-farm-finder-time-range';
const LEADERBOARD_SIZE_KEY = 'destiny-farm-finder-leaderboard-size';
const PROFILE_COMPLETIONS_PAGE_SIZE_KEY = 'destiny-farm-finder-profile-completions-page-size';
const DIFFICULTY_FILTER_KEY = 'destiny-farm-finder-difficulty-filter';
const PLAYERS_FILTER_KEY = 'destiny-farm-finder-players-filter';
const LEADERBOARD_SIZE_OPTIONS = [6, 12, 25, 50, 75, 100] as const;

export type DifficultyFilter = '' | 'normal' | 'master';
export type PlayersFilter = '' | '1' | '2' | '3' | 'lowman';
const VALID_DIFFICULTY: DifficultyFilter[] = ['', 'normal', 'master'];
const VALID_PLAYERS: PlayersFilter[] = ['', '1', '2', '3', 'lowman'];
export const PROFILE_COMPLETIONS_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

/**
 * Persisted view mode toggle (aggregate vs individual).
 * Defaults to 'individual' (Per Raid).
 */
export function useViewMode(): ['aggregate' | 'individual', (mode: 'aggregate' | 'individual') => void] {
    const [mode, setMode] = useState<'aggregate' | 'individual'>(() => {
        if (typeof window === 'undefined') {
            return 'individual';
        }
        try {
            const stored = localStorage.getItem(VIEW_MODE_KEY);
            if (stored === 'aggregate' || stored === 'individual') {
                return stored;
            }
        } catch {
            // Ignore
        }
        return 'individual';
    });

    useEffect(() => {
        try {
            localStorage.setItem(VIEW_MODE_KEY, mode);
        } catch {
            // Ignore
        }
    }, [mode]);

    return [mode, setMode];
}

/**
 * Persisted time range preset value.
 * Defaults to 24 hours.
 */
export function useTimeRange(): [number, (hours: number) => void] {
    const [hours, setHours] = useState(() => {
        if (typeof window === 'undefined') {
            return DEFAULT_TIME_RANGE_HOURS;
        }
        try {
            const stored = localStorage.getItem(TIME_RANGE_KEY);
            if (stored) {
                const parsed = parseInt(stored, 10);
                if (isTimeRangePreset(parsed)) {
                    return parsed;
                }
            }
        } catch {
            // Ignore
        }
        return DEFAULT_TIME_RANGE_HOURS;
    });

    useEffect(() => {
        try {
            localStorage.setItem(TIME_RANGE_KEY, hours.toString());
        } catch {
            // Ignore
        }
    }, [hours]);

    const setTimeRange = useCallback((nextHours: number) => {
        setHours(isTimeRangePreset(nextHours) ? nextHours : DEFAULT_TIME_RANGE_HOURS);
    }, []);

    return [hours, setTimeRange];
}

/**
 * Persisted leaderboard size.
 * Defaults to 50 players.
 */
export function useLeaderboardSize(): [number, (size: number) => void] {
    const [size, setSize] = useState(() => {
        if (typeof window === 'undefined') {
            return 50;
        }
        try {
            const stored = localStorage.getItem(LEADERBOARD_SIZE_KEY);
            if (stored) {
                const parsed = parseInt(stored, 10);
                if (LEADERBOARD_SIZE_OPTIONS.includes(parsed as (typeof LEADERBOARD_SIZE_OPTIONS)[number])) {
                    return parsed;
                }
            }
        } catch {
            // Ignore
        }
        return 50;
    });

    useEffect(() => {
        try {
            localStorage.setItem(LEADERBOARD_SIZE_KEY, size.toString());
        } catch {
            // Ignore
        }
    }, [size]);

    return [size, setSize];
}

/**
 * Persisted player profile Raid Completions rows per page.
 * Defaults to 25 rows.
 */
export function useProfileCompletionsPageSize(): [number, (size: number) => void] {
    const [size, setSize] = useState(() => {
        if (typeof window === 'undefined') {
            return 25;
        }
        try {
            const stored = localStorage.getItem(PROFILE_COMPLETIONS_PAGE_SIZE_KEY);
            if (stored) {
                const parsed = parseInt(stored, 10);
                if (PROFILE_COMPLETIONS_PAGE_SIZE_OPTIONS.includes(parsed as (typeof PROFILE_COMPLETIONS_PAGE_SIZE_OPTIONS)[number])) {
                    return parsed;
                }
            }
        } catch {
            // Ignore
        }
        return 25;
    });

    useEffect(() => {
        try {
            localStorage.setItem(PROFILE_COMPLETIONS_PAGE_SIZE_KEY, size.toString());
        } catch {
            // Ignore
        }
    }, [size]);

    const setPageSize = useCallback((nextSize: number) => {
        if (PROFILE_COMPLETIONS_PAGE_SIZE_OPTIONS.includes(nextSize as (typeof PROFILE_COMPLETIONS_PAGE_SIZE_OPTIONS)[number])) {
            setSize(nextSize);
        }
    }, []);

    return [size, setPageSize];
}

export function useDifficultyFilter(): [DifficultyFilter, (v: DifficultyFilter) => void] {
    const [value, setValue] = useState<DifficultyFilter>(() => {
        if (typeof window === 'undefined') return '';
        try {
            const stored = localStorage.getItem(DIFFICULTY_FILTER_KEY);
            if (VALID_DIFFICULTY.includes(stored as DifficultyFilter)) return stored as DifficultyFilter;
        } catch { /* ignore */ }
        return '';
    });

    useEffect(() => {
        try { localStorage.setItem(DIFFICULTY_FILTER_KEY, value); } catch { /* ignore */ }
    }, [value]);

    return [value, setValue];
}

export function usePlayersFilter(): [PlayersFilter, (v: PlayersFilter) => void] {
    const [value, setValue] = useState<PlayersFilter>(() => {
        if (typeof window === 'undefined') return '';
        try {
            const stored = localStorage.getItem(PLAYERS_FILTER_KEY);
            if (VALID_PLAYERS.includes(stored as PlayersFilter)) return stored as PlayersFilter;
        } catch { /* ignore */ }
        return '';
    });

    useEffect(() => {
        try { localStorage.setItem(PLAYERS_FILTER_KEY, value); } catch { /* ignore */ }
    }, [value]);

    return [value, setValue];
}
