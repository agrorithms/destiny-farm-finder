import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from './rate-limiter';

/**
 * The limiter is the only thing standing between the crawler/scanner worker pools
 * and Bungie's per-key rate limits. Its two guarantees — that concurrent waiters
 * cannot claim the same slot, and that a pause applies to the whole key rather
 * than to one request — are both timing behaviours, so they are tested with fake
 * timers rather than real sleeps.
 */

afterEach(() => {
    vi.useRealTimers();
});

describe('request spacing', () => {
    it('lets the first request through without waiting', async () => {
        vi.useFakeTimers();
        const limiter = new RateLimiter(10);

        const granted = trackSettled(limiter.wait());
        await vi.advanceTimersByTimeAsync(0);

        expect(granted.settled).toBe(true);
    });

    it('spaces the next request by the configured interval', async () => {
        vi.useFakeTimers();
        const limiter = new RateLimiter(10); // 100ms between grants

        limiter.wait();
        const second = trackSettled(limiter.wait());

        await vi.advanceTimersByTimeAsync(99);
        expect(second.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(second.settled).toBe(true);
    });

    it('serializes concurrent waiters instead of letting them burst', async () => {
        // Without the FIFO promise chain, ten simultaneous callers would each read
        // the same nextSlot and fire at once — the exact burst the limiter exists
        // to prevent.
        vi.useFakeTimers();
        const limiter = new RateLimiter(10);

        const order: number[] = [];
        const waiters = Array.from({ length: 5 }, (_, i) =>
            limiter.wait().then(() => order.push(i))
        );

        await vi.advanceTimersByTimeAsync(500);
        await Promise.all(waiters);

        expect(order).toEqual([0, 1, 2, 3, 4]);
    });
});

describe('pausing the key', () => {
    it('defers a request that had not started waiting yet', async () => {
        vi.useFakeTimers();
        const limiter = new RateLimiter(1000); // spacing is negligible here

        limiter.pauseFor(5);
        const granted = trackSettled(limiter.wait());

        await vi.advanceTimersByTimeAsync(4999);
        expect(granted.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(granted.settled).toBe(true);
    });

    it('extends a wait that is already in progress', async () => {
        // The loop in wait() re-reads nextSlot after each sleep precisely so a
        // pause landing mid-sleep is honoured. Without that re-read, a request
        // that was already sleeping would fire straight into a throttled key.
        vi.useFakeTimers();
        const limiter = new RateLimiter(1000);

        limiter.pauseFor(2);
        const granted = trackSettled(limiter.wait());

        await vi.advanceTimersByTimeAsync(1000);
        limiter.pauseFor(5); // arrives while the first wait is still sleeping

        await vi.advanceTimersByTimeAsync(1000);
        expect(granted.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(4000);
        expect(granted.settled).toBe(true);
    });

    it('holds back every queued waiter, not just the one that saw the throttle', async () => {
        // Bungie throttles the key, not the request. A pause that only affected
        // the caller who observed it would let the rest of the pool keep hammering.
        vi.useFakeTimers();
        const limiter = new RateLimiter(1000);

        // Let one waiter through first, so the pause below is demonstrably
        // affecting a queue rather than simply being set before any activity.
        const first = trackSettled(limiter.wait());
        await vi.advanceTimersByTimeAsync(0);
        expect(first.settled).toBe(true);

        const queued = [trackSettled(limiter.wait()), trackSettled(limiter.wait())];
        limiter.pauseFor(3);

        await vi.advanceTimersByTimeAsync(2999);
        expect(queued.map((w) => w.settled)).toEqual([false, false]);

        // Both are released once the pause lifts; the extra tick covers the
        // normal inter-request spacing between the two of them.
        await vi.advanceTimersByTimeAsync(20);
        expect(queued.every((w) => w.settled)).toBe(true);
    });

    it('catches a waiter that has been queued but not yet granted', async () => {
        // Grants are handed out on a microtask, so a pause issued in the same tick
        // as wait() still applies — the caller is queued, not yet through.
        vi.useFakeTimers();
        const limiter = new RateLimiter(1000);

        const granted = trackSettled(limiter.wait());
        limiter.pauseFor(3);

        await vi.advanceTimersByTimeAsync(2999);
        expect(granted.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(granted.settled).toBe(true);
    });

    it('never shortens an existing pause', async () => {
        // pauseFor takes the max, so a 1s game-server backoff arriving during a
        // 10s throttle must not cut the longer pause short.
        vi.useFakeTimers();
        const limiter = new RateLimiter(1000);

        limiter.pauseFor(10);
        limiter.pauseFor(1);
        const granted = trackSettled(limiter.wait());

        await vi.advanceTimersByTimeAsync(9999);
        expect(granted.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(granted.settled).toBe(true);
    });
});

function trackSettled(promise: Promise<void>): { settled: boolean } {
    const state = { settled: false };
    promise.then(
        () => { state.settled = true; },
        () => { state.settled = true; }
    );
    return state;
}
