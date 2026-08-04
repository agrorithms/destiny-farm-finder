import { expect, test } from './support/test-fixtures';
import { RAID_A, seedFireteams } from './support/seed-world';

/**
 * Flow #2, and the first executable proof of ADR 0001 and ADR 0002.
 *
 * `active_sessions` is keyed by membership_id, so one fireteam of six yields six
 * rows. ADR 0001: the display cap is denominated in *fireteams*, counted after
 * dedupe — capping by row is the bug it records, and it silently hid every
 * long-running raid. ADR 0002: the headline count reports the true total even
 * when the cap trims what is rendered.
 *
 * The denomination is proved through the page (8 fireteams / 48 rows -> 8 cards)
 * and the cap through the API's own `limit` parameter. Lowering
 * ACTIVE_SESSION_DISPLAY_LIMIT for the server would have been the tidier way to
 * make the cap bite on the page, but src/app/active-sessions/page.tsx requests
 * `?limit=600` as a hardcoded literal and the route rejects a limit above the
 * configured cap — so lowering it empties the page rather than trimming it.
 * Pinning that would pin a bug.
 */

const FIRETEAMS = 8;
const MEMBERS_PER_FIRETEAM = 6;
const API_LIMIT = 5;

/**
 * Seeded per file, not in globalSetup: getActiveSessions only returns rows
 * checked within the last 900 seconds and upsertActiveSession always stamps
 * checked_at with unixepoch(), so a globally-seeded world would go invisible
 * fifteen minutes into a run.
 *
 * The `81` prefix namespaces these membership ids away from every other spec, so
 * raising `workers` later cannot produce a primary-key collision.
 */
test.beforeAll(async () => {
    seedFireteams({
        count: FIRETEAMS,
        size: MEMBERS_PER_FIRETEAM,
        prefix: '81',
        raid: RAID_A,
    });
});

test.describe('active sessions', () => {
    test('renders one card per fireteam, not one per player', async ({ page }) => {
        await page.goto('/active-sessions');

        // Each card carries the raid name as its h3; the group heading above them
        // is an h2, so this counts cards and nothing else.
        const cards = page.getByRole('heading', { level: 3, name: RAID_A.name });

        // The load-bearing assertion of ADR 0001. Eight fireteams of six are 48
        // rows in active_sessions; a row-denominated page would show 48 cards.
        await expect(cards).toHaveCount(FIRETEAMS);
    });

    test('reports the true fireteam total even when the cap trims the page', async ({ request }) => {
        const response = await request.get(`/api/active-sessions?limit=${API_LIMIT}`);
        expect(response.ok()).toBe(true);

        const body = await response.json() as { total: number; shown: number };

        // ADR 0002: `total` answers "how busy is Destiny right now" and must not
        // be clipped by the cap. `shown` is how many fit under it.
        expect(body.total).toBe(FIRETEAMS);
        expect(body.shown).toBe(API_LIMIT);
    });

    test('counts in fireteams even when the cap is applied', async ({ request }) => {
        // Same request, stated as the invariant ADR 0001 exists to protect: the
        // total is never the raw row count, capped or not.
        const response = await request.get(`/api/active-sessions?limit=${API_LIMIT}`);
        const body = await response.json() as { total: number };

        expect(body.total).not.toBe(FIRETEAMS * MEMBERS_PER_FIRETEAM);
    });

    test('groups the rendered fireteams under their raid', async ({ page }) => {
        await page.goto('/active-sessions');

        await expect(page.getByRole('heading', { level: 2, name: RAID_A.name })).toBeVisible();
        await expect(page.getByText(`${FIRETEAMS} sessions`)).toBeVisible();
    });
});
