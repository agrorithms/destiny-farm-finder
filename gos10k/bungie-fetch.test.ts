import { describe, expect, it } from 'vitest';
import { RateLimiter } from './bungie-fetch';

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
