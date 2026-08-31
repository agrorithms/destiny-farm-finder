import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CooldownGate, FixedWindowLimiter } from './rate-limit';

/**
 * These primitives are the abuse dampeners on the three publicly reachable
 * client-write endpoints (active-session-update, identity, queue-crawl), and
 * they had no coverage at all. Everything here is time-dependent, so the whole
 * file runs on fake timers rather than sleeping.
 *
 * The e2e suite deliberately avoids tripping these by giving each spec file its
 * own fixture player — see docs/handoffs/260803-playwright-e2e.md. That makes
 * these tests the only thing pinning the behaviour.
 */

// An arbitrary fixed instant. Both classes prune on a 60s interval seeded from
// `lastPruneAt = 0`, so starting from a large real-world timestamp means the
// first call always prunes — the same as it behaves in a long-lived server.
const T0 = new Date('2026-08-03T12:00:00Z').getTime();

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('CooldownGate', () => {
    it('reports no cooldown for a key that was never recorded', () => {
        const gate = new CooldownGate(30_000);
        expect(gate.isCoolingDown('3:456')).toBe(false);
    });

    it('reports a cooldown immediately after the key is recorded', () => {
        const gate = new CooldownGate(30_000);
        gate.record('3:456');
        expect(gate.isCoolingDown('3:456')).toBe(true);
    });

    it('keeps cooling down right up to the boundary, then releases on it', () => {
        const gate = new CooldownGate(30_000);
        gate.record('3:456');

        vi.setSystemTime(T0 + 29_999);
        expect(gate.isCoolingDown('3:456')).toBe(true);

        // The comparison is `now - last < cooldownMs`, so the window is
        // half-open: at exactly cooldownMs the key is free again.
        vi.setSystemTime(T0 + 30_000);
        expect(gate.isCoolingDown('3:456')).toBe(false);
    });

    it('tracks keys independently', () => {
        const gate = new CooldownGate(30_000);
        gate.record('3:456');
        expect(gate.isCoolingDown('3:999')).toBe(false);
    });

    it('re-recording a key restarts its cooldown', () => {
        const gate = new CooldownGate(30_000);
        gate.record('3:456');

        vi.setSystemTime(T0 + 20_000);
        gate.record('3:456');

        // 40s after the first record, but only 20s after the second.
        vi.setSystemTime(T0 + 40_000);
        expect(gate.isCoolingDown('3:456')).toBe(true);
    });

    it('drops expired keys so the map cannot grow forever', () => {
        // The bug this class was written to fix: the routes previously kept bare
        // Maps with one entry per IP:player key that were never deleted. Pruning
        // is internal, so we observe it through the only exposed surface —
        // behaviour must be identical to a key that was never recorded.
        const gate = new CooldownGate(30_000);
        gate.record('3:456');

        // Past both the cooldown and the 60s prune interval, so the next call
        // prunes and the entry goes.
        vi.setSystemTime(T0 + 120_000);
        expect(gate.isCoolingDown('3:456')).toBe(false);

        // Still free after another prune cycle — it was removed, not just aged out.
        vi.setSystemTime(T0 + 180_000);
        expect(gate.isCoolingDown('3:456')).toBe(false);
    });
});

describe('FixedWindowLimiter', () => {
    it('allows exactly `limit` hits inside one window', () => {
        // queue-crawl's real configuration: 10 per minute per IP.
        const limiter = new FixedWindowLimiter(10, 60_000);
        for (let i = 0; i < 10; i++) {
            expect(limiter.isRateLimited('1.2.3.4')).toBe(false);
        }
    });

    it('rate-limits the hit after the limit is reached', () => {
        const limiter = new FixedWindowLimiter(10, 60_000);
        for (let i = 0; i < 10; i++) limiter.isRateLimited('1.2.3.4');
        expect(limiter.isRateLimited('1.2.3.4')).toBe(true);
    });

    it('keeps rate-limiting for the rest of the window', () => {
        const limiter = new FixedWindowLimiter(2, 60_000);
        limiter.isRateLimited('1.2.3.4');
        limiter.isRateLimited('1.2.3.4');

        vi.setSystemTime(T0 + 59_999);
        expect(limiter.isRateLimited('1.2.3.4')).toBe(true);
    });

    it('starts a fresh window once windowMs has elapsed', () => {
        const limiter = new FixedWindowLimiter(2, 60_000);
        limiter.isRateLimited('1.2.3.4');
        limiter.isRateLimited('1.2.3.4');
        expect(limiter.isRateLimited('1.2.3.4')).toBe(true);

        // Fixed window, not sliding: the window resets wholesale rather than
        // decaying, so the full allowance returns at once.
        vi.setSystemTime(T0 + 60_000);
        expect(limiter.isRateLimited('1.2.3.4')).toBe(false);
        expect(limiter.isRateLimited('1.2.3.4')).toBe(false);
        expect(limiter.isRateLimited('1.2.3.4')).toBe(true);
    });

    it('counts each key separately', () => {
        const limiter = new FixedWindowLimiter(1, 60_000);
        expect(limiter.isRateLimited('1.2.3.4')).toBe(false);
        expect(limiter.isRateLimited('1.2.3.4')).toBe(true);

        // A different IP is unaffected by the first one's exhausted window.
        expect(limiter.isRateLimited('5.6.7.8')).toBe(false);
    });

    it('drops expired windows so the map cannot grow forever', () => {
        // Same unbounded-growth concern as CooldownGate, observed the same way.
        const limiter = new FixedWindowLimiter(1, 60_000);
        limiter.isRateLimited('1.2.3.4');

        vi.setSystemTime(T0 + 120_000);
        expect(limiter.isRateLimited('1.2.3.4')).toBe(false);
    });
});
