'use client';

import { useState, useEffect } from 'react';

const VIEW_MODE_KEY = 'destiny-farm-finder-view-mode';
const TIME_RANGE_KEY = 'destiny-farm-finder-time-range';

/**
 * Persisted view mode toggle (aggregate vs individual).
 * Defaults to 'individual' (Per Raid).
 */
export function useViewMode(): ['aggregate' | 'individual', (mode: 'aggregate' | 'individual') => void] {
    const [mode, setMode] = useState<'aggregate' | 'individual'>('individual');
    const [initialized, setInitialized] = useState(false);

    useEffect(() => {
        try {
            const stored = localStorage.getItem(VIEW_MODE_KEY);
            if (stored === 'aggregate' || stored === 'individual') {
                setMode(stored);
            }
        } catch {
            // Ignore
        }
        setInitialized(true);
    }, []);

    useEffect(() => {
        if (initialized) {
            try {
                localStorage.setItem(VIEW_MODE_KEY, mode);
            } catch {
                // Ignore
            }
        }
    }, [mode, initialized]);

    return [mode, setMode];
}

/**
 * Persisted time range slider value.
 * Defaults to 4 hours.
 */
export function useTimeRange(): [number, (hours: number) => void] {
    const [hours, setHours] = useState(4);
    const [initialized, setInitialized] = useState(false);

    useEffect(() => {
        try {
            const stored = localStorage.getItem(TIME_RANGE_KEY);
            if (stored) {
                const parsed = parseFloat(stored);
                if (!isNaN(parsed) && parsed >= 1 && parsed <= 8) {
                    setHours(parsed);
                }
            }
        } catch {
            // Ignore
        }
        setInitialized(true);
    }, []);

    useEffect(() => {
        if (initialized) {
            try {
                localStorage.setItem(TIME_RANGE_KEY, hours.toString());
            } catch {
                // Ignore
            }
        }
    }, [hours, initialized]);

    return [hours, setHours];
}
