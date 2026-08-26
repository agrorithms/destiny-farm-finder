import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/players/identity/route';
import { buildWriteRequest } from '../helpers/build-write-request';
import { withDbQuiesced } from '../helpers/db-quiesce';
import { installWriteRouteEnv } from './write-route-setup';

installWriteRouteEnv();

function validBody(membershipId = '4611686018488107374') {
    return {
        membershipId,
        membershipType: 3,
        bungieGlobalDisplayName: 'TestGuardian',
        bungieGlobalDisplayNameCode: 1234,
    };
}

function post(body: Record<string, unknown> | string, options?: { origin?: string; ip?: string }) {
    return POST(buildWriteRequest('/api/players/identity', body, options));
}

describe('POST /api/players/identity', () => {
    it('returns 403 when the request is not trusted (cross-origin)', async () => {
        const response = await post(validBody(), { origin: 'https://evil.example.com' });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
    });

    it('returns 400 for invalid JSON', async () => {
        const response = await post('{not json');
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    });

    it('returns 400 for an invalid membershipId', async () => {
        const response = await post({ ...validBody(), membershipId: 'not-a-number' });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid membershipId' });
    });

    it('returns 400 for an invalid membershipType', async () => {
        const response = await post({ ...validBody(), membershipType: 99 });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid membershipType' });
    });

    it('returns 400 when bungieGlobalDisplayName is missing', async () => {
        const response = await post({
            membershipId: '4611686018488107374',
            membershipType: 3,
            bungieGlobalDisplayNameCode: 1234,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Missing bungieGlobalDisplayName' });
    });

    it('stores a new player identity and returns stored: true', async () => {
        const response = await post(validBody('4611686018488100001'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ stored: true });
    });

    it('returns stored: false with reason recently_updated on cooldown', async () => {
        const id = '4611686018488100002';
        await post(validBody(id));

        const response = await post(validBody(id));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ stored: false, reason: 'recently_updated' });
    });

    it('returns 503 when the database is in maintenance', async () => {
        const response = await withDbQuiesced(() => post(validBody('4611686018488100003')));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ stored: false, reason: 'maintenance' });
    });
});
