import type { Page } from '@playwright/test';
import { expect, test } from './support/test-fixtures';
import { RAID_A, seedPlayerWithSession } from './support/seed-world';
import { seedPlayer } from '../tests/helpers/seed';
import { buildActiveProfile } from '../tests/helpers/bungie-profile-builder';

/**
 * Browser-level proof that mintPageToken() survives the RSC boundary into a real
 * x-page-token header, and that verifyActiveSessionLive takes the correct path
 * for two scenarios:
 *
 *   Scenario 1 — Happy path: active session, no unresolved roster members.
 *   Scenario 3 — Private account: Bungie returns error code 1665 (privacy).
 *
 * Scenarios 2 and 4 (unresolved-members enrichment, provisional fireteam
 * resolution) are covered by #64.
 *
 * Bungie stubs use builder-generated fixtures from tests/helpers/bungie-profile-builder.ts
 * (presets from #62), replacing the empty placeholder in test-fixtures.ts for these tests.
 *
 * Requires NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY to have been set at build time —
 * the browser's fetchPlayerProfileClient throws before making a network request
 * when the key is missing, and the stub never fires.
 */

// Namespace prefix 83: membership IDs and display names, per convention.
const HAPPY_ID = '4611686018488300001';
const HAPPY_NAME = 'HappyGuardian83';
const HAPPY_CODE = 8301;

const PRIVATE_ID = '4611686018488300002';
const PRIVATE_NAME = 'PrivateGuardian83';
const PRIVATE_CODE = 8302;

interface NetworkEntry {
    method: string;
    path: string;
    hasPageToken: boolean;
}

async function interceptApiCalls(page: Page, log: NetworkEntry[]): Promise<void> {
    await page.route('**/api/players/**', async (route) => {
        const url = new URL(route.request().url());
        log.push({
            method: route.request().method(),
            path: url.pathname + url.search,
            hasPageToken: 'x-page-token' in route.request().headers(),
        });
        await route.continue();
    });
}

test.beforeAll(() => {
    seedPlayer(HAPPY_ID, HAPPY_NAME, HAPPY_CODE);
    seedPlayerWithSession({
        membershipId: PRIVATE_ID,
        name: PRIVATE_NAME,
        code: PRIVATE_CODE,
        raid: RAID_A,
    });
});

test.describe('client-write verify', () => {
    test('happy path: Bungie profile → active-session-update → session card → queue-crawl', async ({ page }) => {
        const log: NetworkEntry[] = [];
        await interceptApiCalls(page, log);

        // Stub Bungie GetProfile with a builder-generated active profile.
        const profile = buildActiveProfile({
            membershipId: HAPPY_ID,
            membershipType: 3,
            displayName: HAPPY_NAME,
            bungieGlobalDisplayName: HAPPY_NAME,
            bungieGlobalDisplayNameCode: HAPPY_CODE,
            partyMembers: [
                { membershipId: HAPPY_ID, displayName: HAPPY_NAME, status: 1 },
            ],
        });

        await page.route('**/Platform/Destiny2/**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ErrorCode: 1,
                    ErrorStatus: 'Success',
                    Message: 'Ok',
                    ThrottleSeconds: 0,
                    Response: profile,
                }),
            });
        });

        // Set up waiter for queue-crawl before navigating — it is fire-and-forget
        // and may resolve before the await.
        const queueCrawlDone = page.waitForResponse(
            (res) => res.url().includes('/api/players/queue-crawl') && res.request().method() === 'POST',
            { timeout: 15_000 },
        );

        await page.goto(`/player/3/${HAPPY_ID}`);

        // Session card rendered: the POST processed the builder profile, stored a
        // Salvation's Edge session, and the client set it from the response.
        await expect(
            page.getByRole('heading', { level: 3, name: RAID_A.name }),
        ).toBeVisible({ timeout: 10_000 });

        // Wait for the fire-and-forget queue-crawl to complete.
        await queueCrawlDone;

        // --- Network ordering assertions ---

        const posts = log.filter((e) => e.method === 'POST');
        const updatePost = posts.find((e) => e.path.includes('active-session-update'));
        const crawlPost = posts.find((e) => e.path.includes('queue-crawl'));
        const identityPost = posts.find((e) => e.path.includes('/identity'));

        // active-session-update fired with page token.
        expect(updatePost).toBeDefined();
        expect(updatePost!.hasPageToken).toBe(true);

        // queue-crawl fired with page token.
        expect(crawlPost).toBeDefined();
        expect(crawlPost!.hasPageToken).toBe(true);

        // active-session-update before queue-crawl.
        expect(posts.indexOf(updatePost!)).toBeLessThan(posts.indexOf(crawlPost!));

        // No identity POST — no unresolved roster members.
        expect(identityPost).toBeUndefined();

        // Baseline GET fired.
        expect(log.some((e) => e.method === 'GET' && e.path.includes('part=active'))).toBe(true);
    });

    test('private account: privacy error skips POST, reads containing session', async ({ page }) => {
        const log: NetworkEntry[] = [];
        await interceptApiCalls(page, log);

        // Stub Bungie GetProfile with error code 1665 (privacy restriction).
        await page.route('**/Platform/Destiny2/**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ErrorCode: 1665,
                    ErrorStatus: 'DestinyPrivacyRestriction',
                    Message: 'No peeking.',
                    ThrottleSeconds: 0,
                    Response: {},
                }),
            });
        });

        await page.goto(`/player/3/${PRIVATE_ID}`);

        // Privacy banner proves the 1665 path ran.
        await expect(
            page.getByText('The user has chosen for this data to be private'),
        ).toBeVisible({ timeout: 10_000 });

        // Session card from the containing session.
        await expect(
            page.getByRole('heading', { level: 3, name: RAID_A.name }),
        ).toBeVisible({ timeout: 10_000 });

        // Let any straggler fire-and-forget calls settle.
        await page.waitForLoadState('networkidle');

        // --- Network ordering assertions ---

        // GET with containing=1 fired (the privacy fallback path).
        expect(log.some((e) => e.method === 'GET' && e.path.includes('containing=1'))).toBe(true);

        // No POST to active-session-update — Bungie call failed before the POST.
        const posts = log.filter((e) => e.method === 'POST');
        expect(posts.some((e) => e.path.includes('active-session-update'))).toBe(false);

        // No POST to queue-crawl — queueCrawlOnce skipped because accountPrivate.
        expect(posts.some((e) => e.path.includes('queue-crawl'))).toBe(false);
    });
});
