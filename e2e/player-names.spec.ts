import { expect, test } from './support/test-fixtures';

/**
 * Flow #3. A player is identified by `Name#Code` and the full form must reach
 * the screen. Truncated names were a real production bug, which is why
 * CLAUDE.md makes storing `bungie_global_display_name` in full a convention.
 *
 * Two distinct failures are covered:
 *   - dropping the discriminator entirely, rendering a bare name
 *   - dropping the zero-padding, rendering "#7" where Bungie means "#0007"
 *
 * The padding case is the one most likely to regress unnoticed: it looks like a
 * valid name, just a different player's.
 */

test.describe('player identity', () => {
    test('renders the full Name#Code on the leaderboard', async ({ page }) => {
        await page.goto('/leaderboard');

        await expect(page.getByRole('link', { name: 'FixtureAlpha#4242' })).toBeVisible();
    });

    test('zero-pads a short discriminator to four digits', async ({ page }) => {
        await page.goto('/leaderboard');

        // FixtureBravo is seeded with code 7. Bungie's canonical form is #0007;
        // formatBungieDisplayName pads it, and this is the only test that proves
        // the padded form survives all the way to the rendered row.
        await expect(page.getByRole('link', { name: 'FixtureBravo#0007' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'FixtureBravo#7', exact: true })).toHaveCount(0);
    });

    test('never renders a bare name without its discriminator', async ({ page }) => {
        await page.goto('/leaderboard');

        // Anchored on both ends: a bare "FixtureCharlie" link means the code was
        // lost somewhere between the players table and the row.
        await expect(page.getByRole('link', { name: /^FixtureCharlie$/ })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'FixtureCharlie#1111' })).toBeVisible();
    });

    test('links each name to that player\'s profile', async ({ page }) => {
        await page.goto('/leaderboard');

        // membershipType 3 is what the fixture seeds; a wrong type here produces a
        // profile page that resolves to nobody.
        await expect(page.getByRole('link', { name: 'FixtureAlpha#4242' }))
            .toHaveAttribute('href', '/player/3/4611686018400010001');
    });
});
