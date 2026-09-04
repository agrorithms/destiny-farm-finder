import type { NextResponse } from 'next/server';

export function cacheControl(sMaxAgeSeconds: number, staleWhileRevalidateSeconds: number): string {
    return `public, max-age=0, s-maxage=${sMaxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`;
}

const ARCHIVE_MAX_AGE_SECONDS = 86400;

/**
 * For the Archive: a frozen, complete dataset whose last row was written before the
 * page existed and that will never gain another. This is the one place on the site
 * where a stale response is not a bug but the correct answer, so it gets a real
 * browser `max-age` and `immutable` rather than the `max-age=0, s-maxage=N` shape the
 * live routes use — there is nothing to revalidate.
 *
 * Setting it here is only half the story. Cloudflare cache rules, which are not in this
 * repo, rewrite what actually reaches the browser: a rule with no Browser TTL falls back
 * to a 4h zone default, which is how /api/live-stats once served max-age=14400 from a
 * repo that had never emitted a non-zero max-age. Check `cf-cache-status` and the header
 * prod returns before trusting this. See docs/decisions.md.
 */
export function archiveCacheControl(): string {
    return `public, max-age=${ARCHIVE_MAX_AGE_SECONDS}, s-maxage=${ARCHIVE_MAX_AGE_SECONDS}, immutable`;
}

export function noStore(): string {
    return 'no-store';
}

export function withCache<T extends NextResponse>(response: T, sMaxAgeSeconds: number, staleWhileRevalidateSeconds: number): T {
    response.headers.set('Cache-Control', cacheControl(sMaxAgeSeconds, staleWhileRevalidateSeconds));
    return response;
}

export function withNoStore<T extends NextResponse>(response: T): T {
    response.headers.set('Cache-Control', noStore());
    return response;
}
