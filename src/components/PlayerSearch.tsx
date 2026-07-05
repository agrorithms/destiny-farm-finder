'use client';

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    describeClientBungieError,
    isClientBungieError,
    searchBungiePlayerClient,
} from '@/lib/bungie/client-api';
import type { PlayerInfo } from '@/lib/bungie/types';

interface SearchResult {
    membershipId: string;
    membershipType: number;
    displayName: string;
    baseName: string;
    secondaryDisplayName: string;
    isExactFullMatch: boolean;
    isExactNameMatch: boolean;
    notTracked?: boolean;
}

interface SearchApiResponse {
    results?: SearchResult[];
    fallbackUnavailable?: boolean;
    message?: string;
}

export default function PlayerSearch() {
    const router = useRouter();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const requestOrderRef = useRef(0);
    const latestAppliedRequestRef = useRef(0);
    const localRequestSeqRef = useRef(0);
    const fallbackRequestSeqRef = useRef(0);
    const resultsRef = useRef<SearchResult[]>([]);
    const trimmedRef = useRef('');

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [fallbackLoading, setFallbackLoading] = useState(false);
    const [fallbackUnavailable, setFallbackUnavailable] = useState(false);
    const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(-1);

    const trimmed = query.trim();

    useEffect(() => {
        resultsRef.current = results;
    }, [results]);

    useEffect(() => {
        trimmedRef.current = trimmed;
    }, [trimmed]);

    useEffect(() => {
        const onClickOutside = (event: MouseEvent) => {
            if (!containerRef.current) return;
            if (!containerRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };

        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, []);

    useEffect(() => {
        if (trimmed.length < 2) {
            setResults([]);
            setOpen(false);
            setError(null);
            setFallbackUnavailable(false);
            setFallbackMessage(null);
            setFallbackLoading(false);
            setSelectedIndex(-1);
            return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(async () => {
            const requestId = ++localRequestSeqRef.current;
            const requestOrder = ++requestOrderRef.current;
            setLoading(true);
            setError(null);
            setFallbackUnavailable(false);
            setFallbackMessage(null);

            try {
                const res = await fetch(
                    `/api/players/search?query=${encodeURIComponent(trimmed)}&limit=10`,
                    { signal: controller.signal }
                );
                if (!res.ok) throw new Error(`Search failed (${res.status})`);
                const data = await res.json() as SearchApiResponse;
                if (requestId !== localRequestSeqRef.current || trimmed !== trimmedRef.current) return;
                if (requestOrder < latestAppliedRequestRef.current) return;
                latestAppliedRequestRef.current = requestOrder;

                const nextResults = data.results || [];
                setResults(nextResults);
                setOpen(true);
                setSelectedIndex(nextResults.length > 0 ? 0 : -1);
            } catch (err) {
                if ((err as Error).name === 'AbortError') return;
                if (requestId !== localRequestSeqRef.current || trimmed !== trimmedRef.current) return;

                setError((err as Error).message);
                setSelectedIndex(-1);
            } finally {
                if (requestId === localRequestSeqRef.current) setLoading(false);
            }
        }, 250);

        return () => {
            controller.abort();
            clearTimeout(timeout);
        };
    }, [trimmed]);

    useEffect(() => {
        const baseName = getSearchBaseName(trimmed);

        if (baseName.length < 3) {
            setFallbackLoading(false);
            setFallbackUnavailable(false);
            setFallbackMessage(null);
            return;
        }

        let cancelled = false;
        const timeout = setTimeout(async () => {
            if (resultsRef.current.some((result) => result.isExactFullMatch)) {
                return;
            }

            const requestId = ++fallbackRequestSeqRef.current;
            const requestOrder = ++requestOrderRef.current;
            setFallbackLoading(true);
            setError(null);

            try {
                // Query Bungie directly from the browser (public key) instead of the server,
                // so user search traffic never consumes the server's API budget.
                const players = await searchBungiePlayerClient(trimmed);
                if (cancelled) return;
                if (requestId !== fallbackRequestSeqRef.current || trimmed !== trimmedRef.current) return;
                if (requestOrder < latestAppliedRequestRef.current) return;
                latestAppliedRequestRef.current = requestOrder;

                const localKeys = new Set(resultsRef.current.map((r) => r.membershipId));
                const merged = new Map(resultsRef.current.map((r) => [r.membershipId, r]));
                for (const player of players) {
                    const result = mapPlayerInfoToResult(player, trimmed, !localKeys.has(player.membershipId));
                    if (!merged.has(result.membershipId)) {
                        merged.set(result.membershipId, result);
                    }
                }

                const nextResults = [...merged.values()];
                setResults(nextResults);
                setFallbackUnavailable(false);
                setFallbackMessage(null);
                setOpen(true);
                setSelectedIndex(nextResults.length > 0 ? 0 : -1);

                // NOTE: we intentionally do NOT queue crawls here. A prefix search returns
                // many players and re-runs as the user types, which would flood queue-crawl.
                // The crawl is queued instead when the user actually opens a profile.
            } catch (err) {
                if (cancelled) return;
                if (requestId !== fallbackRequestSeqRef.current || trimmed !== trimmedRef.current) return;

                if (isClientBungieError(err)) {
                    setFallbackUnavailable(true);
                    setFallbackMessage(describeClientBungieError(err));
                } else {
                    console.warn('Bungie search failed:', err);
                }
            } finally {
                if (!cancelled && requestId === fallbackRequestSeqRef.current) setFallbackLoading(false);
            }
        }, 700);

        return () => {
            cancelled = true;
            clearTimeout(timeout);
        };
    }, [trimmed]);

    const hasExact = useMemo(
        () => results.some((r) => r.isExactFullMatch || r.isExactNameMatch),
        [results]
    );

    const goToPlayer = (result: SearchResult) => {
        setOpen(false);
        router.push(`/player/${result.membershipType}/${result.membershipId}`);
    };

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();

        if (selectedIndex >= 0 && selectedIndex < results.length) {
            goToPlayer(results[selectedIndex]);
            return;
        }

        if (results.length === 1) {
            goToPlayer(results[0]);
            return;
        }

        const exactMatch = results.find((r) => r.isExactFullMatch);
        if (exactMatch) {
            goToPlayer(exactMatch);
            return;
        }

        setOpen(true);
    };

    const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (!open || results.length === 0) {
            if (event.key === 'ArrowDown' && results.length > 0) {
                setOpen(true);
                setSelectedIndex(0);
            }
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % results.length);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1));
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            return;
        }
    };

    return (
        <div ref={containerRef} className="relative w-full max-w-md">
            <form onSubmit={onSubmit} className="flex items-center gap-2">
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onFocus={() => {
                        if (results.length > 0 || fallbackUnavailable || error) setOpen(true);
                    }}
                    onKeyDown={onInputKeyDown}
                    type="text"
                    placeholder="Search player"
                    className="w-full rounded-lg ui-input ui-focus-accent px-3 py-2 text-sm placeholder:text-[var(--ui-text-muted)] focus:outline-none"
                />
                <button
                    type="submit"
                    className="rounded-lg ui-btn-primary text-sm px-3 py-2 shrink-0"
                    aria-label="Search"
                >
                    <span className="hidden sm:inline">Search</span>
                    <svg
                        className="sm:hidden"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        aria-hidden="true"
                    >
                        <circle cx="11" cy="11" r="7" />
                        <path d="m21 21-4.35-4.35" />
                    </svg>
                </button>
            </form>

            {open && (
                <div className="absolute top-full mt-2 right-0 w-full min-w-72 rounded-lg ui-input shadow-xl z-50 overflow-hidden">
                    {loading && (
                        <div className="px-3 py-2 text-sm ui-text-secondary">Searching...</div>
                    )}

                    {!loading && error && (
                        <div className="px-3 py-2 text-sm text-red-400">{error}</div>
                    )}

                    {!loading && !error && results.length === 0 && (
                        <div className="px-3 py-2 text-sm ui-text-secondary">
                            No matches found in local player database.
                        </div>
                    )}

                    {!loading && !error && results.length > 0 && (
                        <>
                            {!hasExact && (
                                <div className="px-3 py-2 text-xs ui-text-muted border-b ui-divider">
                                    Multiple players can share the same base name. Select the exact profile.
                                </div>
                            )}
                            <div className="max-h-72 overflow-y-auto">
                                {results.map((result, index) => (
                                    <button
                                        key={`${result.membershipType}:${result.membershipId}`}
                                        type="button"
                                        onClick={() => goToPlayer(result)}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                        className={`w-full text-left px-3 py-2 text-sm ui-list-item-hover ${selectedIndex === index
                                            ? 'ui-list-item-active'
                                            : ''
                                            }`}
                                    >
                                        <div className="ui-text-primary">{result.displayName}</div>
                                        <div className="text-xs ui-text-muted">
                                            {getMembershipTypeLabel(result.membershipType)}
                                            {(result.secondaryDisplayName || result.baseName)
                                                && (result.secondaryDisplayName || result.baseName).toLowerCase() !== result.displayName.toLowerCase()
                                                ? ` • ${result.secondaryDisplayName || result.baseName}`
                                                : ''}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </>
                    )}

                    {!loading && !error && fallbackLoading && (
                        <div className="px-3 py-2 text-xs ui-text-muted border-t ui-divider">
                            Searching Bungie...
                        </div>
                    )}

                    {!loading && !error && fallbackUnavailable && (
                        <div className="px-3 py-2 text-xs ui-text-muted border-t ui-divider">
                            {fallbackMessage || 'Bungie search unavailable'}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function getSearchBaseName(query: string): string {
    const hashIndex = query.indexOf('#');
    return (hashIndex === -1 ? query : query.slice(0, hashIndex)).trim();
}

function mapPlayerInfoToResult(player: PlayerInfo, query: string, notTracked: boolean): SearchResult {
    const code = player.bungieGlobalDisplayNameCode;
    const baseName = player.bungieGlobalDisplayName || player.displayName || player.membershipId;
    const fullName = player.bungieGlobalDisplayName && code !== undefined
        ? `${player.bungieGlobalDisplayName}#${String(code).padStart(4, '0')}`
        : baseName;
    const queryBaseName = getSearchBaseName(query).toLowerCase();

    return {
        membershipId: player.membershipId,
        membershipType: player.membershipType,
        displayName: fullName,
        baseName,
        secondaryDisplayName: player.displayName || player.membershipId,
        isExactFullMatch: fullName.toLowerCase() === query.trim().toLowerCase(),
        isExactNameMatch: baseName.toLowerCase() === queryBaseName,
        notTracked,
    };
}

function getMembershipTypeLabel(membershipType: number): string {
    switch (membershipType) {
        case 1: return 'Xbox';
        case 2: return 'PlayStation';
        case 3: return 'Steam';
        case 5: return 'Stadia';
        case 6: return 'Epic';
        default: return 'Unknown Platform';
    }
}
