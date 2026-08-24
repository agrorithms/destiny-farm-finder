import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resetTestDb, testDb } from '../../../../../tests/helpers/db';
import { buildWriteRequest } from '../../../../../tests/helpers/build-write-request';

const SECRET = 'test-secret-not-a-real-credential';
const T0 = new Date('2026-08-03T12:00:00Z').getTime();

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.stubEnv('PAGE_TOKEN_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://destinyfarmfinder.qzz.io');
    resetTestDb();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

function validBody(membershipId = '4611686018488200001') {
    return {
        membershipId,
        membershipType: 3,
        displayName: 'TestGuardian',
    };
}

describe('POST /api/players/queue-crawl', () => {
    it('returns 403 when the request is not trusted', async () => {
        const { POST } = await import('./route');
        const request = buildWriteRequest('/api/players/queue-crawl', validBody(), {
            origin: 'https://evil.example.com',
        });
        const response = await POST(request);
        expect(response.status).toBe(403);
        const json = await response.json();
        expect(json).toEqual({ error: 'Forbidden' });
    });

    it('returns 400 for an invalid membershipId', async () => {
        const { POST } = await import('./route');
        const request = buildWriteRequest('/api/players/queue-crawl', {
            ...validBody(),
            membershipId: 'abc',
        });
        const response = await POST(request);
        expect(response.status).toBe(400);
        const json = await response.json();
        expect(json).toEqual({ error: 'Invalid membershipId' });
    });

    it('returns 400 for an invalid membershipType', async () => {
        const { POST } = await import('./route');
        const request = buildWriteRequest('/api/players/queue-crawl', {
            ...validBody(),
            membershipType: 42,
        });
        const response = await POST(request);
        expect(response.status).toBe(400);
        const json = await response.json();
        expect(json).toEqual({ error: 'Invalid membershipType' });
    });

    it('returns 429 when the per-IP rate limit is exceeded', async () => {
        const { POST } = await import('./route');
        const ip = '10.0.0.1';
        // FixedWindowLimiter: 10 per 60s per IP. Each call needs a unique
        // membership ID so the per-player CooldownGate doesn't fire first.
        for (let i = 0; i < 10; i++) {
            const id = `461168601848830${String(i).padStart(4, '0')}`;
            await POST(buildWriteRequest('/api/players/queue-crawl', validBody(id), { ip }));
        }
        const id = '4611686018488309999';
        const response = await POST(
            buildWriteRequest('/api/players/queue-crawl', validBody(id), { ip })
        );
        expect(response.status).toBe(429);
        const json = await response.json();
        expect(json).toEqual({ queued: false, reason: 'rate_limited' });
    });

    it('returns queued: false with reason recently_refreshed on cooldown', async () => {
        const { POST } = await import('./route');
        const id = '4611686018488200002';
        const ip = '10.0.0.2';
        await POST(buildWriteRequest('/api/players/queue-crawl', validBody(id), { ip }));

        const response = await POST(
            buildWriteRequest('/api/players/queue-crawl', validBody(id), { ip })
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ queued: false, reason: 'recently_refreshed' });
    });

    it('returns queued: false with reason backing_off when the player is backing off', async () => {
        const { POST } = await import('./route');
        const id = '4611686018488200003';
        const ip = '10.0.0.3';

        const db = testDb();
        db.prepare(
            `INSERT INTO players (membership_id, membership_type, next_eligible_at)
             VALUES (?, 3, unixepoch() + 3600)`
        ).run(id);

        const response = await POST(
            buildWriteRequest('/api/players/queue-crawl', validBody(id), { ip })
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ queued: false, reason: 'backing_off' });
    });

    it('enqueues the player and returns 202 on the happy path', async () => {
        const { POST } = await import('./route');
        const id = '4611686018488200004';
        const ip = '10.0.0.4';
        const response = await POST(
            buildWriteRequest('/api/players/queue-crawl', validBody(id), { ip })
        );
        expect(response.status).toBe(202);
        const json = await response.json();
        expect(json).toEqual({ queued: true });
    });

    it('returns 503 when the database is in maintenance', async () => {
        const { POST } = await import('./route');
        const id = '4611686018488200005';
        const ip = '10.0.0.5';

        // Pragmatic ADR 0004 exception: fault injection on the DB function to
        // test the maintenance error path without actually triggering quiesce.
        const queries = await import('@/lib/db/queries');
        const { DatabaseMaintenanceError } = await import('@/lib/db');
        vi.spyOn(queries, 'isPlayerCrawlBackingOff').mockImplementation(() => {
            throw new DatabaseMaintenanceError();
        });

        const response = await POST(
            buildWriteRequest('/api/players/queue-crawl', validBody(id), { ip })
        );
        expect(response.status).toBe(503);
        const json = await response.json();
        expect(json).toEqual({ queued: false, reason: 'maintenance' });

        vi.restoreAllMocks();
    });
});
