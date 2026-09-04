import { describe, expect, it } from 'vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { createBungieFetch, RateLimiter } from './bungie-fetch';

/**
 * These exist because the PGCR backfill made the limiter concurrent.
 *
 * Sequentially, a limiter that stores `lastCallTime` after sleeping is correct
 * and these tests would pass against it. With N callers in flight it is not: all
 * N read the same timestamp, compute the same delay, and wake together — the
 * limiter goes from pacing the run to doing nothing, exactly when exceeding
 * Bungie's 25 rps ceiling starts to matter. The concurrent case below is the
 * one that separates the two implementations.
 */

describe('RateLimiter', () => {
    it('spaces sequential calls by the configured interval', async () => {
        const limiter = new RateLimiter(100); // 10ms apart
        const started = Date.now();
        for (let i = 0; i < 5; i++) await limiter.wait();
        // 5 calls => 4 gaps => >= 40ms. Lower bound only: timers may overshoot,
        // and asserting an upper bound would make this flaky on a loaded box.
        expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    });

    it('spaces CONCURRENT callers too, rather than releasing them together', async () => {
        const limiter = new RateLimiter(100); // 10ms apart
        const started = Date.now();

        // All ten ask at once, as ten pool workers do on the first tick.
        const fireTimes: number[] = [];
        await Promise.all(
            Array.from({ length: 10 }, async () => {
                await limiter.wait();
                fireTimes.push(Date.now() - started);
            })
        );

        // The naive implementation releases all ten in the same tick and this
        // total lands near 0.
        expect(Math.max(...fireTimes)).toBeGreaterThanOrEqual(80);
    });

    it('does not delay the first call', async () => {
        const limiter = new RateLimiter(1); // 1 second apart
        const started = Date.now();
        await limiter.wait();
        expect(Date.now() - started).toBeLessThan(50);
    });

    it('clamps above Bungie’s documented ceiling', async () => {
        // Asking for 1000 rps must not produce 1000 rps.
        const limiter = new RateLimiter(1000);
        const started = Date.now();
        for (let i = 0; i < 3; i++) await limiter.wait();
        // Clamped to 25 rps => 40ms apart => 2 gaps => >= 80ms.
        expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    });
});

describe('fetchRaw — transport failures', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        // The backoff is 2s, 4s, ... — real timers would make this a minute long.
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        globalThis.fetch = originalFetch;
    });

    /** Runs a promise to completion while advancing fake timers. */
    async function settle<T>(p: Promise<T>): Promise<T> {
        const done = p.then(
            (v) => ({ ok: true as const, v }),
            (e) => ({ ok: false as const, e })
        );
        await vi.runAllTimersAsync();
        const r = await done;
        if (!r.ok) throw r.e;
        return r.v;
    }

    it('retries a dropped connection and succeeds', async () => {
        // The exact shape that killed a real run with ~1000 PGCRs to go: fetch
        // REJECTS rather than returning a status, so nothing downstream that
        // inspects httpStatus can see it — it has to be caught here.
        const reset = Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        });

        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
            calls++;
            if (calls <= 2) throw reset;
            return { status: 200, json: async () => ({ ErrorCode: 1, Response: { ok: true } }) } as Response;
        }) as unknown as typeof fetch;

        const { fetchRaw } = createBungieFetch(25);
        const result = await settle(fetchRaw('https://example.test/pgcr/1/', {}));

        expect(calls).toBe(3);
        expect(result.httpStatus).toBe(200);
        expect(result.body.Response).toEqual({ ok: true });
    });

    it('gives up after the retry budget rather than spinning forever', async () => {
        // A persistent outage must end the run with a clear error, not retry
        // indefinitely while appearing to make progress.
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch;

        const { fetchRaw } = createBungieFetch(25);
        await expect(settle(fetchRaw('https://example.test/pgcr/1/', {}))).rejects.toThrow(
            /Network error after 5 retries/
        );
        // 1 initial attempt + 5 retries.
        expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    });

    it('does not retry an HTTP error status — only a transport failure', async () => {
        // A 500 is a fatal outcome the classifier is responsible for, not
        // something to paper over with retries here.
        globalThis.fetch = vi.fn(async () => ({ status: 500, json: async () => ({}) })) as unknown as typeof fetch;

        const { fetchRaw } = createBungieFetch(25);
        const result = await settle(fetchRaw('https://example.test/pgcr/1/', {}));

        expect(result.httpStatus).toBe(500);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
});
