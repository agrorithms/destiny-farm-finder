import { expect, test } from './support/test-fixtures';

/**
 * Flow #4. The theme preference is a three-state cycle held in localStorage, and
 * the initial `.dark` class is applied before paint by an inline script in
 * layout.tsx. Neither the cycle nor that pre-paint script is reachable from a
 * Node test — this is the only place they are exercised.
 *
 * Playwright gives each test a fresh browser context, so storage starts empty
 * and the default ('system') is what the page sees. Persistence therefore has to
 * be proven with a reload inside one test rather than across two.
 */

const themeButton = /^Theme: (light|dark|system)/;

test.describe('theme toggle', () => {
    test('cycles system → light → dark and survives a reload', async ({ page }) => {
        await page.goto('/');

        const toggle = page.getByRole('button', { name: themeButton });

        // Playwright's default color scheme is light, so 'system' resolves to a
        // light document — the class is what the inline script actually sets.
        await expect(toggle).toHaveAccessibleName(/^Theme: system/);
        await expect(page.locator('html')).not.toHaveClass(/dark/);

        await toggle.click();
        await expect(toggle).toHaveAccessibleName(/^Theme: light/);
        await expect(page.locator('html')).not.toHaveClass(/dark/);

        await toggle.click();
        await expect(toggle).toHaveAccessibleName(/^Theme: dark/);
        await expect(page.locator('html')).toHaveClass(/dark/);

        await page.reload();

        // The assertion that matters: after a reload the button reports 'dark'
        // (preference read back from localStorage) *and* the html element already
        // carries the class (the pre-paint script honoured it). If only the first
        // held, users would get a flash of the wrong theme on every navigation.
        await expect(toggle).toHaveAccessibleName(/^Theme: dark/);
        await expect(page.locator('html')).toHaveClass(/dark/);
    });

    test('completes the cycle back to system', async ({ page }) => {
        await page.goto('/');
        const toggle = page.getByRole('button', { name: themeButton });

        await toggle.click(); // system -> light
        await toggle.click(); // light  -> dark
        await toggle.click(); // dark   -> system

        await expect(toggle).toHaveAccessibleName(/^Theme: system/);
        await expect(page.locator('html')).not.toHaveClass(/dark/);
    });
});
