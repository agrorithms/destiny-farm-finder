import type { Page } from '@playwright/test';
import { expect, test } from './support/test-fixtures';
import { RAID_A, RAID_B } from './support/seed-world';

/**
 * Flow #1. Changing the raid filter must ask the server for the filtered set and
 * show the answer.
 *
 * Both halves are asserted deliberately. A DOM-only check would also pass if the
 * page filtered rows it had already fetched — a regression that looks harmless
 * in review and quietly breaks every filter combination that needs a different
 * query. A request-only check would prove the ask but not the arrival.
 *
 * The filter lives in localStorage (useRaidFilter), not the URL, so there is no
 * deep-link form of this test and each test starts from a clean context.
 */

/** Top of each raid's board — see LEADERBOARD_PLAYERS in ./support/seed-world. */
const RAID_A_PLAYER = 'FixtureAlpha#4242';
const RAID_B_PLAYER = 'FixtureDelta#2222';

async function selectRaid(page: Page, raidName: string): Promise<void> {
    await page.getByRole('button', { name: 'All Raids' }).click();
    await page.getByRole('option', { name: raidName }).click();
}

test.describe('leaderboard', () => {
    test('renders seeded players from every raid by default', async ({ page }) => {
        await page.goto('/leaderboard');

        // Unfiltered means all raids, so both rosters share one aggregate board.
        await expect(page.getByRole('link', { name: RAID_A_PLAYER })).toBeVisible();
        await expect(page.getByRole('link', { name: RAID_B_PLAYER })).toBeVisible();
    });

    test('selecting a raid refetches for that raid and swaps the board', async ({ page }) => {
        await page.goto('/leaderboard');
        await expect(page.getByRole('link', { name: RAID_B_PLAYER })).toBeVisible();

        // Armed before the click: the request is what proves a refetch happened
        // rather than a client-side filter of rows already in memory.
        const filteredRequest = page.waitForRequest((request) =>
            request.url().includes('/api/leaderboard')
            && new URL(request.url()).searchParams.get('raids') === RAID_A.key
        );

        await selectRaid(page, RAID_A.name);

        await filteredRequest;

        // ...and the answer reached the screen. The two rosters are deliberately
        // non-overlapping, so a correct filter swaps the board wholesale rather
        // than trimming it — which makes the negative assertion meaningful.
        await expect(page.getByRole('link', { name: RAID_A_PLAYER })).toBeVisible();
        await expect(page.getByRole('link', { name: RAID_B_PLAYER })).toHaveCount(0);
    });

    test('keeps the selected filter across a reload', async ({ page }) => {
        await page.goto('/leaderboard');

        await selectRaid(page, RAID_B.name);
        await expect(page.getByRole('link', { name: RAID_B_PLAYER })).toBeVisible();

        await page.reload();

        // useRaidFilter persists to localStorage so a filter survives navigation.
        await expect(page.getByRole('button', { name: RAID_B.name })).toBeVisible();
        await expect(page.getByRole('link', { name: RAID_B_PLAYER })).toBeVisible();
        await expect(page.getByRole('link', { name: RAID_A_PLAYER })).toHaveCount(0);
    });
});
