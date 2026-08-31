import { afterEach, beforeEach, vi } from 'vitest';
import { resetTestDb } from '../helpers/db';

/** Frozen clock for every client-write route test, so token TTLs and cooldowns
 *  are reasoned about relative to a known instant. */
export const T0 = new Date('2026-08-03T12:00:00Z').getTime();

const SECRET = 'test-secret-not-a-real-credential';

/**
 * Registers the environment the three client-write routes need: a page-token
 * secret (without it isTrustedClientWrite skips the token layer entirely and the
 * tests would prove less than they claim), the site URL the same-origin check
 * allowlists, a frozen clock, and an empty database.
 *
 * Shared rather than copied into each file so the env contract has one home —
 * these routes all sit behind the same guard.
 */
// Not named use* — that reads as a React hook to eslint, and this is a Vitest hook.
export function installWriteRouteEnv(): void {
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
}
