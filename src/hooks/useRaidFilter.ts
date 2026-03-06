'use client';

import { useState, useEffect } from 'react';

const STORAGE_KEY = 'destiny-farm-finder-raid-filter';

/**
 * Shared hook for raid filter state.
 * Persists selections to localStorage so they survive page navigation.
 */
export function useRaidFilter(): [string[], (selected: string[]) => void] {
    const [selectedRaids, setSelectedRaids] = useState<string[]>([]);
    const [initialized, setInitialized] = useState(false);

    // Load from localStorage on mount
    useEffect(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) {
                    setSelectedRaids(parsed);
                }
            }
        } catch {
            // Ignore parse errors
        }
        setInitialized(true);
    }, []);

    // Save to localStorage whenever selection changes (after initial load)
    useEffect(() => {
        if (initialized) {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedRaids));
            } catch {
                // Ignore storage errors
            }
        }
    }, [selectedRaids, initialized]);

    return [selectedRaids, setSelectedRaids];
}
