import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resetTestDb } from '../../../../../tests/helpers/db';
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

function validBody(membershipId = '4611686018488107374') {
    return {
        membershipId,
        membershipType: 3,
        bungieGlobalDisplayName: 'TestGuardian',
        bungieGlobalDisplayNameCode: 1234,
    };
}

describe('POST /api/players/identity', () => {
    it('returns 403 when the request is not trusted (cross-origin)', async () => {
        const { POST } = await import('./route');
        const request = buildWriteRequest('/api/players/identity', validBody(), {
            origin: 'https://evil.example.com',
        });
        const response = await POST(request);
        expect(response.status).toBe(403);
        const json = await response.json();
        expect(json).toEqual({ error: 'Forbidden' });
    });

    it('returns 400 for an invalid membershipId', async () => {
        const { POST } = await import('./route');
        const request = buildWriteRequest('/api/players/identity', {
            ...validBody(),
            membershipId: 'not-a-number',
        });
        const response = await POST(request);
        expect(response.status).toBe(400);
        const json = await response.json();
        expect(json).toEqual({ error: 'Invalid membershipId' });
    });

    it('returns 400 for an invalid membershipType', async () => {
        const { POST } = await import('./route');
        const request = buildWriteRequest('/api/players/identity', {
            ...validBody(),
            membershipType: 99,
        });
        const response = await POST(request);
        expect(response.status).toBe(400);
        const json = await response.json();
        expect(json).toEqual({ error: 'Invalid membershipType' });
    });

    it('returns 400 when bungieGlobalDisplayName is missing', async () => {
        const { POST } = await import('./route');
        const body = {
            membershipId: '4611686018488107374',
            membershipType: 3,
            bungieGlobalDisplayNameCode: 1234,
        };
        const request = buildWriteRequest('/api/players/identity', body);
        const response = await POST(request);
        expect(response.status).toBe(400);
        const json = await response.json();
        expect(json).toEqual({ error: 'Missing bungieGlobalDisplayName' });
    });

    it('stores a new player identity and returns stored: true', async () => {
        const { POST } = await import('./route');
        const id = '4611686018488100001';
        const request = buildWriteRequest('/api/players/identity', validBody(id));
        const response = await POST(request);
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ stored: true });
    });

    it('returns stored: false with reason recently_updated on cooldown', async () => {
        const { POST } = await import('./route');
        const id = '4611686018488100002';
        const first = buildWriteRequest('/api/players/identity', validBody(id));
        await POST(first);

        const second = buildWriteRequest('/api/players/identity', validBody(id));
        const response = await POST(second);
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ stored: false, reason: 'recently_updated' });
    });

    it('returns 503 when the database is in maintenance', async () => {
        const { POST } = await import('./route');
        const id = '4611686018488100003';

        // Pragmatic ADR 0004 exception: fault injection on the DB function to
        // test the maintenance error path without actually triggering quiesce.
        const queries = await import('@/lib/db/queries');
        const { DatabaseMaintenanceError } = await import('@/lib/db');
        vi.spyOn(queries, 'upsertPlayerFillOnly').mockImplementation(() => {
            throw new DatabaseMaintenanceError();
        });

        const request = buildWriteRequest('/api/players/identity', validBody(id));
        const response = await POST(request);
        expect(response.status).toBe(503);
        const json = await response.json();
        expect(json).toEqual({ stored: false, reason: 'maintenance' });

        vi.restoreAllMocks();
    });
});
