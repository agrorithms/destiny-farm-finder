import { NextRequest, NextResponse } from 'next/server';
import { enqueueCrawl, isPlayerCrawlBackingOff } from '@/lib/db/queries';
import { isDatabaseMaintenanceError } from '@/lib/db';
import { withNoStore } from '@/lib/http/cache';
import { getClientIp } from '@/lib/http/request-ip';
import { isTrustedClientWrite } from '@/lib/http/request-auth';
import { CooldownGate, FixedWindowLimiter } from '@/lib/http/rate-limit';

const validMembershipTypes = new Set([1, 2, 3, 5, 6]);

// Per-player cooldown: don't re-enqueue the same player more than once per 2 minutes.
const enqueueCooldown = new CooldownGate(120_000);

// Per-IP fixed window: at most 10 queue requests per minute per IP.
const ipLimiter = new FixedWindowLimiter(10, 60_000);

interface QueueCrawlBody {
    membershipId?: unknown;
    membershipType?: unknown;
    displayName?: unknown;
}

export async function POST(request: NextRequest) {
    if (!isTrustedClientWrite(request)) {
        return withNoStore(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    }

    let body: QueueCrawlBody;
    try {
        body = await request.json();
    } catch {
        return withNoStore(NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }));
    }

    const membershipId = typeof body.membershipId === 'string' ? body.membershipId.trim() : '';
    const membershipType = Number(body.membershipType);
    const displayName = typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim()
        : null;

    if (!/^\d{1,20}$/.test(membershipId)) {
        return withNoStore(NextResponse.json({ error: 'Invalid membershipId' }, { status: 400 }));
    }
    if (!validMembershipTypes.has(membershipType)) {
        return withNoStore(NextResponse.json({ error: 'Invalid membershipType' }, { status: 400 }));
    }

    const ip = getClientIp(request);
    if (ipLimiter.isRateLimited(ip)) {
        return withNoStore(NextResponse.json(
            { queued: false, reason: 'rate_limited' },
            { status: 429 }
        ));
    }

    const key = `${membershipType}:${membershipId}`;
    if (enqueueCooldown.isCoolingDown(key)) {
        return withNoStore(NextResponse.json({ queued: false, reason: 'recently_refreshed' }));
    }

    try {
        // Crawl-failure / privacy backoff (players.next_eligible_at): don't re-enqueue a
        // player the crawler is deliberately leaving alone. drainCrawlQueue enforces this
        // too; declining here keeps the queue clean and the reason observable.
        if (isPlayerCrawlBackingOff(membershipId)) {
            return withNoStore(NextResponse.json({ queued: false, reason: 'backing_off' }));
        }

        enqueueCrawl([{ membershipId, membershipType, displayName }], 'profile-view');
        enqueueCooldown.record(key);
        return withNoStore(NextResponse.json({ queued: true }, { status: 202 }));
    } catch (error) {
        if (isDatabaseMaintenanceError(error)) {
            return withNoStore(NextResponse.json(
                { queued: false, reason: 'maintenance' },
                { status: 503 }
            ));
        }
        console.error('[ERROR] queue-crawl failed:', error);
        return withNoStore(NextResponse.json({ error: 'Internal server error' }, { status: 500 }));
    }
}
