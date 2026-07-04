'use client';

import { useEffect, useSyncExternalStore } from 'react';

// Tiny pub/sub bridging pages and the nav StatsBar: pages that auto-refresh their
// own data publish "my data updated at X, I refresh every Ys" so the nav strip's
// ticker reflects page data instead of the strip's own poll. Cleared on unmount so
// a page's timestamp never leaks onto other routes.

export interface PageLiveStatus {
    lastUpdated: Date | null;
    refreshIntervalSec: number;
}

let current: PageLiveStatus | null = null;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Publish this page's data freshness while the page is mounted. */
export function useReportPageLiveStatus(lastUpdated: Date | null, refreshIntervalSec: number) {
    useEffect(() => {
        current = { lastUpdated, refreshIntervalSec };
        emit();
        return () => {
            current = null;
            emit();
        };
    }, [lastUpdated, refreshIntervalSec]);
}

/** The current page's reported freshness, or null when the page doesn't report one. */
export function usePageLiveStatus(): PageLiveStatus | null {
    return useSyncExternalStore(subscribe, () => current, () => null);
}
