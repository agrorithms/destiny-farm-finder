import type { Locator, Page } from '@playwright/test';
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

/**
 * Asserts every raid option in the open dropdown. Scoped to the listbox — the
 * page's other controls are native <select>s, whose <option> elements carry the
 * same role and would otherwise be swept into this locator.
 */
async function expectEveryOptionSelected(listbox: Locator, ariaSelected: 'true' | 'false'): Promise<void> {
    const options = listbox.getByRole('option');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThan(0);
    for (let i = 0; i < optionCount; i++) {
        await expect(options.nth(i)).toHaveAttribute('aria-selected', ariaSelected);
    }
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

    test('raid filter is keyboard-navigable', async ({ page }) => {
        await page.goto('/leaderboard');

        const trigger = page.getByRole('button', { name: 'All Raids' });
        const listbox = page.getByRole('listbox');
        await trigger.focus();

        // Enter on the trigger opens the dropdown (native button click).
        await page.keyboard.press('Enter');
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await expect(listbox).toBeVisible();

        // Escape closes it and returns focus to the trigger.
        await page.keyboard.press('Escape');
        await expect(listbox).not.toBeVisible();
        await expect(trigger).toBeFocused();

        // ArrowDown on the trigger re-opens and focuses the listbox.
        await page.keyboard.press('ArrowDown');
        await expect(listbox).toBeVisible();

        // Arrow down to the second option.
        await page.keyboard.press('ArrowDown');
        const secondOption = page.getByRole('option').nth(1);
        const secondOptionId = await secondOption.getAttribute('id');
        expect(secondOptionId).toBeTruthy();
        await expect(listbox).toHaveAttribute('aria-activedescendant', secondOptionId!);

        // Space toggles the focused option's selection.
        await page.keyboard.press('Space');
        await expect(secondOption).toHaveAttribute('aria-selected', 'true');

        // Shift+Tab from the listbox reaches the utility buttons (Q8).
        await page.keyboard.press('Shift+Tab');
        await expect(page.getByRole('button', { name: 'Clear Filter' })).toBeFocused();
        await expect(listbox).toBeVisible();

        // Tab back to the listbox, then Tab past it to close the dropdown (Q9).
        await page.keyboard.press('Tab');
        await expect(listbox).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(listbox).not.toBeVisible();
    });

    /**
     * Regression: the Select All / Clear Filter buttons did nothing on iOS.
     *
     * WebKit does not focus a <button> on tap, and Chrome and Edge on iOS are both
     * WKWebView. So tapping either utility button blurred the listbox with a null
     * relatedTarget; RaidMultiSelect's focusout handler read that as "focus left the
     * dropdown", closed it, and React unmounted the button before its click could
     * dispatch. The dropdown shut and the selection never changed.
     *
     * Chromium focuses buttons on mousedown, so it cannot reproduce the tap itself.
     * The blur() below produces the event the tap actually produced — a real
     * focusout carrying no relatedTarget — which is the trigger the handler got
     * wrong. Treat this as a proxy for WebKit's focus semantics, not a reproduction
     * of them: iOS stays unverified here until a webkit project lands.
     */
    test('utility buttons still act when the listbox blurs to nothing', async ({ page }) => {
        await page.goto('/leaderboard');

        await page.getByRole('button', { name: 'All Raids' }).click();
        const listbox = page.getByRole('listbox');
        await expect(listbox).toBeVisible();

        // Opening focuses the listbox, so this is a genuine focusout to nowhere —
        // exactly what the iOS tap delivered before the click landed.
        await listbox.evaluate((el: HTMLElement) => el.blur());

        // Half one of the reported symptom: the dropdown must not close.
        await expect(listbox).toBeVisible();

        await page.getByRole('button', { name: 'Select All' }).click();

        // Half two: the change must actually be made — and the dropdown must still
        // be open afterwards, which is the symptom as reported ("the filter dropdown
        // closes, but the change is not actually made"). Asserted after the click as
        // well as after the blur, because those are two different close paths.
        await expect(listbox).toBeVisible();
        await expectEveryOptionSelected(listbox, 'true');

        // Clear Filter is the same code path, and the one a user reaches for to
        // undo the above — assert it too rather than trusting the shared handler.
        await page.getByRole('button', { name: 'Clear Filter' }).click();
        await expect(listbox).toBeVisible();
        await expectEveryOptionSelected(listbox, 'false');
    });
});
