import { afterEach, describe, expect, it, vi } from 'vitest';
import { BungieAPIError, BungieClient } from './client';

/**
 * Mocked at the fetch boundary only — never at our own module boundaries.
 * Stubbing `getPGCR` would test the stub; stubbing `fetch` tests the response
 * handling that actually decides whether a raid gets ingested or dropped.
 *
 * `request()` does no retrying. What it does is classify a failure and, when
 * Bungie signals throttling, pause the shared per-key rate limiter — because the
 * throttle applies to the key, not to the one request that happened to see it.
 * These tests cover that classification and that dispatch.
 */

const PGCR_BODY = {
    Response: { activityDetails: { instanceId: '123' } },
    ErrorCode: 1,
    ErrorStatus: 'Success',
    Message: 'Ok',
    ThrottleSeconds: 0,
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
    });
}

/** High RPS so ordinary spacing never interferes with what a test is asserting. */
function makeClient(): BungieClient {
    return new BungieClient('test-api-key', 1000);
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('successful responses', () => {
    it('returns the parsed payload', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PGCR_BODY)));

        const result = await makeClient().getPGCR('123');

        expect(result.Response.activityDetails.instanceId).toBe('123');
    });

    it('authenticates with the API key header', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PGCR_BODY));
        vi.stubGlobal('fetch', fetchMock);

        await makeClient().getPGCR('123');

        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers['X-API-Key']).toBe('test-api-key');
    });

    it('requests the PGCR from the stats host', async () => {
        // PGCRs live on stats.bungie.net, not www.bungie.net. Getting this wrong
        // fails every ingestion path at once.
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PGCR_BODY));
        vi.stubGlobal('fetch', fetchMock);

        await makeClient().getPGCR('123');

        expect(String(fetchMock.mock.calls[0][0])).toContain(
            'stats.bungie.net/Platform/Destiny2/Stats/PostGameCarnageReport/123/'
        );
    });
});

describe('Bungie-level errors', () => {
    it('raises a typed error carrying Bungie\'s own code and status', async () => {
        // The type matters: isBungieSystemDisabledError is instanceof-based, so a
        // generic Error here would stop the crawler ever pausing for maintenance.
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                jsonResponse({
                    Response: null,
                    ErrorCode: 5,
                    ErrorStatus: 'SystemDisabled',
                    Message: 'This system is temporarily disabled.',
                    ThrottleSeconds: 0,
                })
            )
        );

        const error = await makeClient().getPGCR('123').catch((e) => e);

        expect(error).toBeInstanceOf(BungieAPIError);
        expect(error.errorCode).toBe(5);
        expect(error.errorStatus).toBe('SystemDisabled');
    });

    it('raises an untyped error for a plain HTTP failure', async () => {
        // A 5xx is not a Bungie-level error — the body may not even be JSON — so it
        // must not masquerade as one.
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response('<html>gateway timeout</html>', { status: 504 }))
        );

        const error = await makeClient().getPGCR('123').catch((e) => e);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(BungieAPIError);
        expect(error.message).toContain('504');
    });

    it('survives a non-JSON error body without masking the failure', async () => {
        // Cloudflare serves HTML error pages. The 1672 inspection parses the body,
        // so it must swallow the parse failure and still throw.
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response('<!DOCTYPE html><h1>502</h1>', { status: 502 }))
        );

        await expect(makeClient().getPGCR('123')).rejects.toThrow(/502/);
    });
});

describe('throttle handling pauses the whole key', () => {
    it('defers the next request after Bungie reports a throttle', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(jsonResponse({ ...PGCR_BODY, ThrottleSeconds: 4 }))
        );
        const client = makeClient();

        await client.getPGCR('123');

        const second = trackSettled(client.getPGCR('456'));
        await vi.advanceTimersByTimeAsync(3999);
        expect(second.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(20);
        expect(second.settled).toBe(true);
    });

    it('honours Retry-After on an HTTP 429', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response('rate limited', { status: 429, headers: { 'Retry-After': '7' } })
            )
        );
        const client = makeClient();

        await client.getPGCR('123').catch(() => {});

        const second = trackSettled(client.getPGCR('456').catch(() => {}));
        await vi.advanceTimersByTimeAsync(6999);
        expect(second.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(20);
        expect(second.settled).toBe(true);
    });

    it('falls back to a five second pause when 429 omits Retry-After', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));
        const client = makeClient();

        await client.getPGCR('123').catch(() => {});

        const second = trackSettled(client.getPGCR('456').catch(() => {}));
        await vi.advanceTimersByTimeAsync(4999);
        expect(second.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(20);
        expect(second.settled).toBe(true);
    });

    it('imposes its own backoff for a game-server throttle, which reports no duration', async () => {
        // ErrorCode 1672 arrives as a 503 with ThrottleSeconds: 0. Bungie tells us
        // to back off without saying how long, so retrying immediately would just
        // earn another 503. Default self-imposed pause is 2s.
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({ ErrorCode: 1672, ErrorStatus: 'DestinyThrottledByGameServer', ThrottleSeconds: 0 }),
                    { status: 503 }
                )
            )
        );
        const client = makeClient();

        await client.getPGCR('123').catch(() => {});

        const second = trackSettled(client.getPGCR('456').catch(() => {}));
        await vi.advanceTimersByTimeAsync(1999);
        expect(second.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(20);
        expect(second.settled).toBe(true);
    });
});

function trackSettled(promise: Promise<unknown>): { settled: boolean } {
    const state = { settled: false };
    promise.then(
        () => { state.settled = true; },
        () => { state.settled = true; }
    );
    return state;
}
