import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/players/queue-crawl/route';
import { recordCrawlOutcome } from '@/lib/db/queries';
import { buildWriteRequest } from '../helpers/build-write-request';
import { withDbQuiesced } from '../helpers/db-quiesce';
import { seedPlayer } from '../helpers/seed';
import { installWriteRouteEnv } from './write-route-setup';

installWriteRouteEnv();

function validBody(membershipId = '4611686018488200001') {
    return {
        membershipId,
        membershipType: 3,
        displayName: 'TestGuardian',
    };
}

function post(body: Record<string, unknown> | string, options?: { origin?: string; ip?: string }) {
    return POST(buildWriteRequest('/api/players/queue-crawl', body, options));
}

describe('POST /api/players/queue-crawl', () => {
    it('returns 403 when the request is not trusted', async () => {
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
        const response = await post({ ...validBody(), membershipId: 'abc' });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid membershipId' });
    });

    it('returns 400 for an invalid membershipType', async () => {
        const response = await post({ ...validBody(), membershipType: 42 });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid membershipType' });
    });

    it('returns 429 when the per-IP rate limit is exceeded', async () => {
        const ip = '10.0.0.1';
        // FixedWindowLimiter: 10 per 60s per IP. Each call needs a unique
        // membership ID so the per-player CooldownGate doesn't fire first.
        for (let i = 0; i < 10; i++) {
            await post(validBody(`461168601848830${String(i).padStart(4, '0')}`), { ip });
        }
        const response = await post(validBody('4611686018488309999'), { ip });
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ queued: false, reason: 'rate_limited' });
    });

    it('returns queued: false with reason recently_refreshed on cooldown', async () => {
        const id = '4611686018488200002';
        const ip = '10.0.0.2';
        await post(validBody(id), { ip });

        const response = await post(validBody(id), { ip });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ queued: false, reason: 'recently_refreshed' });
    });

    it('returns queued: false with reason backing_off when the player is backing off', async () => {
        const id = '4611686018488200003';

        // Through the production writer rather than an INSERT that sets
        // next_eligible_at directly: a row in backoff also carries an attempt
        // timestamp, and a hand-written one would be a row the crawler could
        // never produce.
        seedPlayer(id);
        recordCrawlOutcome(id, 'privacy');

        const response = await post(validBody(id), { ip: '10.0.0.3' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ queued: false, reason: 'backing_off' });
    });

    it('enqueues the player and returns 202 on the happy path', async () => {
        const response = await post(validBody('4611686018488200004'), { ip: '10.0.0.4' });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ queued: true });
    });

    it('returns 503 when the database is in maintenance', async () => {
        const response = await withDbQuiesced(() =>
            post(validBody('4611686018488200005'), { ip: '10.0.0.5' })
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ queued: false, reason: 'maintenance' });
    });
});
