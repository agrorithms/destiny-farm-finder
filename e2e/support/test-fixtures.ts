import { test as base, expect } from '@playwright/test';

/**
 * The browser-side equivalent of tests/setup/no-network.ts.
 *
 * That file swaps `globalThis.fetch` in the Node test process, which reaches
 * neither the browser's JS context nor the Next server — so it does nothing
 * here. Same intent, different mechanism: every external request is either
 * answered from a fixture or failed loudly, and nothing reaches the real
 * internet. Import `test` from this module rather than from '@playwright/test'
 * so no spec can opt out by accident.
 */

/** The app under test. Everything else is intercepted. */
function isLocal(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Telemetry the app loads on every page. Answered with a 200 rather than
 * aborted: both DSNs/URLs are hardcoded in application code, so the calls happen
 * on every page load, and an abort leaves genuine failed requests in the page
 * that a future "no console errors" assertion would trip on. A 200 keeps the
 * SDKs quiet. Sentry's *server* side is handled separately by
 * SENTRY_ENVIRONMENT=e2e — see the plan's D4.
 */
function isTelemetry(hostname: string): boolean {
    return hostname.endsWith('.sentry.io') || hostname.endsWith('umami.is');
}

/**
 * External assets loaded by application pages (e.g. third-party favicons on the
 * player profile page). Fulfilled with a 200 so the browser does not report a
 * failed resource load, but the content is empty — the test does not care about
 * rendering these images.
 */
function isExternalAsset(hostname: string): boolean {
    return hostname === 'raid.report' || hostname === 'raidhub.io';
}

function isBungie(hostname: string): boolean {
    return hostname === 'bungie.net' || hostname.endsWith('.bungie.net');
}

export const test = base.extend<{ blockExternalRequests: void }>({
    blockExternalRequests: [
        async ({ page }, use, testInfo) => {
            const unexpected: string[] = [];

            // One handler rather than several overlapping globs: route order in
            // Playwright is reverse-registration, which makes layered patterns
            // hard to reason about, and a URL glob that silently fails to match
            // reopens the exact hole this fixture exists to close.
            await page.route('**/*', async (route) => {
                const url = route.request().url();

                let hostname: string;
                try {
                    hostname = new URL(url).hostname;
                } catch {
                    unexpected.push(url);
                    await route.abort();
                    return;
                }

                if (isLocal(hostname)) {
                    await route.continue();
                    return;
                }

                if (isTelemetry(hostname)) {
                    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
                    return;
                }

                if (isExternalAsset(hostname)) {
                    await route.fulfill({ status: 200, contentType: 'image/x-icon', body: '' });
                    return;
                }

                if (isBungie(hostname)) {
                    // Fallback stub: specs that make browser → Bungie calls register
                    // per-test page.route handlers with builder-generated fixtures
                    // (see client-write-verify.spec.ts), which override this for
                    // their specific endpoints. This success envelope remains the
                    // default for any Bungie request that no per-test handler claims.
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ ErrorCode: 1, Response: {} }),
                    });
                    return;
                }

                // Anything else is a call this suite did not anticipate. Record
                // and abort, so it surfaces as a named failure rather than as
                // silent real traffic.
                unexpected.push(url);
                await route.abort();
            });

            await use();

            // Reported after the test body so a genuine assertion failure wins the
            // error message; this only speaks up when the test otherwise passed.
            if (unexpected.length > 0 && testInfo.status === testInfo.expectedStatus) {
                throw new Error(
                    `Unstubbed external request(s) during this test:\n  ${unexpected.join('\n  ')}\n` +
                    'Add a page.route stub in e2e/support/test-fixtures.ts, or fix the code that made the call.'
                );
            }
        },
        { auto: true },
    ],
});

export { expect };
