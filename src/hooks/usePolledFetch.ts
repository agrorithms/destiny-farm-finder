'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Shared fetch lifecycle for pages that poll a JSON endpoint: interval refetch,
// manual refresh, and the stale-response guards the leaderboard page pioneered
// (abort the previous request, discard responses from superseded requests).
// `data` holds the previous payload while a refetch is in flight and is never
// cleared on error, so consumers can render steadily across polls.

export interface PolledFetchResult<T> {
    data: T | null;
    /** True while a request is in flight (including the initial load). */
    loading: boolean;
    error: string | null;
    lastUpdated: Date | null;
    refresh: () => void;
}

export function usePolledFetch<T>(url: string, intervalMs: number): PolledFetchResult<T> {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

    const requestIdRef = useRef(0);
    const activeControllerRef = useRef<AbortController | null>(null);

    const refresh = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        activeControllerRef.current?.abort();
        const controller = new AbortController();
        activeControllerRef.current = controller;

        setLoading(true);

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }
            const result = (await response.json()) as T;
            if (requestId !== requestIdRef.current) {
                return;
            }
            setData(result);
            setError(null);
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
    }, [url]);

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, intervalMs);
        return () => {
            clearInterval(interval);
            activeControllerRef.current?.abort();
        };
    }, [refresh, intervalMs]);

    return { data, loading, error, lastUpdated, refresh };
}
