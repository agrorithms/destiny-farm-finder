import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { archiveCacheControl } from '@/lib/http/cache';

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

interface RateLimitRule {
    bucket: string;
    limit: number;
    windowMs: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
let lastPruneAt = 0;

const noStoreHeaders = {
    'Cache-Control': 'no-store',
};

function unauthorizedResponse(realm = 'Admin Stats') {
    return new NextResponse('Authentication required', {
        status: 401,
        headers: {
            ...noStoreHeaders,
            'WWW-Authenticate': `Basic realm="${realm}"`,
        },
    });
}

function jsonNoStore(body: Record<string, unknown>, status: number, headers?: Record<string, string>) {
    return NextResponse.json(body, {
        status,
        headers: {
            ...noStoreHeaders,
            ...headers,
        },
    });
}

function adminStatsAuthorized(request: NextRequest): NextResponse | null {
    const expectedPassword = process.env.ADMIN_STATS_PASSWORD;
    const expectedUsername = process.env.ADMIN_STATS_USERNAME || 'admin';

    if (!expectedPassword) {
        return new NextResponse('Admin password is not configured.', {
            status: 503,
            headers: noStoreHeaders,
        });
    }

    const auth = request.headers.get('authorization');
    if (!auth || !auth.startsWith('Basic ')) {
        return unauthorizedResponse();
    }

    const encoded = auth.slice(6);
    let decoded = '';
    try {
        decoded = atob(encoded);
    } catch {
        return unauthorizedResponse();
    }

    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
        return unauthorizedResponse();
    }

    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);

    if (username !== expectedUsername || password !== expectedPassword) {
        return unauthorizedResponse();
    }

    return null;
}

function discoveryAuthorized(request: NextRequest): NextResponse | null {
    const expectedToken = process.env.DISCOVERY_API_TOKEN;
    if (!expectedToken) {
        return jsonNoStore({ error: 'Discovery API token is not configured.' }, 503);
    }

    const authorization = request.headers.get('authorization') || '';
    const bearerToken = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : '';
    const headerToken = request.headers.get('x-admin-api-key') || '';
    const token = bearerToken || headerToken;

    if (!token) {
        return jsonNoStore(
            { error: 'Discovery authentication required.' },
            401,
            { 'WWW-Authenticate': 'Bearer realm="Discovery API"' }
        );
    }

    if (token !== expectedToken) {
        return jsonNoStore({ error: 'Invalid discovery authentication token.' }, 403);
    }

    return null;
}

function getClientIp(request: NextRequest): string {
    const cfIp = request.headers.get('cf-connecting-ip');
    if (cfIp) return cfIp;

    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
        return forwardedFor.split(',')[0]?.trim() || 'unknown';
    }

    return request.headers.get('x-real-ip') || 'unknown';
}

function pruneExpiredBuckets(now: number) {
    if (now - lastPruneAt < 60_000) return;

    for (const [key, entry] of rateLimitStore.entries()) {
        if (entry.resetAt <= now) {
            rateLimitStore.delete(key);
        }
    }

    lastPruneAt = now;
}

function rateLimitResponse(rule: RateLimitRule, entry: RateLimitEntry, now: number) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return jsonNoStore(
        { error: 'Too many requests. Please try again shortly.' },
        429,
        {
            'Retry-After': String(retryAfterSeconds),
            'X-RateLimit-Limit': String(rule.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
        }
    );
}

function applyRateLimit(request: NextRequest, rules: RateLimitRule[]): NextResponse | null {
    if (rules.length === 0) return null;

    const now = Date.now();
    pruneExpiredBuckets(now);

    const ip = getClientIp(request);
    const entries = rules.map((rule) => {
        const key = `${rule.bucket}:${ip}`;
        const existing = rateLimitStore.get(key);
        const entry = existing && existing.resetAt > now
            ? existing
            : { count: 0, resetAt: now + rule.windowMs };
        return { key, rule, entry };
    });

    for (const { rule, entry } of entries) {
        if (entry.count >= rule.limit) {
            return rateLimitResponse(rule, entry, now);
        }
    }

    for (const { key, entry } of entries) {
        entry.count += 1;
        rateLimitStore.set(key, entry);
    }

    return null;
}

function isAdminStatsPath(pathname: string): boolean {
    return pathname === '/api/stats' || pathname === '/admin/stats' || pathname.startsWith('/admin/stats/');
}

function getRateLimitRules(request: NextRequest): RateLimitRule[] {
    const { pathname, searchParams } = request.nextUrl;

    if (pathname === '/api/players/search') {
        return [{ bucket: 'players-search', limit: 30, windowMs: 60_000 }];
    }

    if (pathname.startsWith('/api/players/')) {
        if (searchParams.get('refresh') === '1') {
            return [
                { bucket: 'players-refresh-minute', limit: 10, windowMs: 60_000 },
                { bucket: 'players-refresh-hour', limit: 100, windowMs: 60 * 60_000 },
            ];
        }

        if (searchParams.get('part') === 'active' && searchParams.get('verify') === '1') {
            return [{ bucket: 'players-active-verify', limit: 45, windowMs: 60_000 }];
        }

        return [{ bucket: 'players-read', limit: 60, windowMs: 60_000 }];
    }

    if (pathname === '/api/leaderboard') {
        return [{ bucket: 'leaderboard', limit: 60, windowMs: 60_000 }];
    }

    if (pathname === '/api/active-sessions') {
        return [{ bucket: 'active-sessions', limit: 60, windowMs: 60_000 }];
    }

    if (pathname === '/api/status') {
        return [{ bucket: 'status', limit: 120, windowMs: 60_000 }];
    }

    if (pathname === '/api/discovery') {
        return [{ bucket: 'discovery', limit: 3, windowMs: 15 * 60_000 }];
    }

    // Reserved before any /api/gos10k route exists. The matcher below is an explicit
    // list, so anything unlisted gets no rate limiting at all and does so *silently* —
    // the failure mode of forgetting is an endpoint that simply works until someone
    // loops 13,420 detail requests on a 2-OCPU box. Generous on purpose: this is
    // read-only SQLite over a frozen file, not a Bungie-backed endpoint.
    if (pathname.startsWith('/api/gos10k/')) {
        return [{ bucket: 'gos10k-api', limit: 120, windowMs: 60_000 }];
    }

    return [];
}

export function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    if (isAdminStatsPath(pathname)) {
        const authResponse = adminStatsAuthorized(request);
        if (authResponse) return authResponse;
    }

    if (pathname === '/api/discovery') {
        const authResponse = discoveryAuthorized(request);
        if (authResponse) return authResponse;
    }

    const rateLimit = applyRateLimit(request, getRateLimitRules(request));
    if (rateLimit) return rateLimit;

    const response = NextResponse.next();

    // The Archive is frozen, so a stale response is the correct one. Set here rather
    // than in the route because a server component cannot set response headers, and
    // this keeps the one page whose caching rule is the opposite of every other page's
    // beside the rate limits it also needs. Cloudflare has the final say — verify
    // against cf-cache-status on prod (docs/decisions.md).
    if (pathname === '/gos10k' || pathname.startsWith('/gos10k/')) {
        response.headers.set('Cache-Control', archiveCacheControl());
    }

    return response;
}

export const config = {
    matcher: [
        '/admin/stats/:path*',
        '/api/stats',
        '/api/discovery',
        '/api/status',
        '/api/leaderboard',
        '/api/active-sessions',
        '/api/players/:path*',
        '/api/gos10k/:path*',
        '/gos10k/:path*',
        '/gos10k',
    ],
};
