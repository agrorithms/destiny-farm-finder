import { expect, test } from './support/test-fixtures';
import { RAID_A, seedPlayerWithSession } from './support/seed-world';
import { buildActiveProfile, buildLinkedProfiles } from '../tests/helpers/bungie-profile-builder';
import { formatBungieDisplayName } from '../src/lib/db/queries';
import { callIndex, callIndexes, interceptApiCalls, waitForQueueCrawl } from './support/network-log';
import { fulfillBungie } from './support/bungie-stub';

/**
 * Scenario 2 — the full Name#Code enrichment round-trip, end to end in a browser.
 *
 *   1. Browser fetches the host's Bungie profile; the fireteam contains two members
 *      with no identity row, so they arrive as bare membership ids.
 *   2. active-session-update POST stores the session and returns unresolvedMemberIds.
 *   3. resolveUnknownMembersAndRefresh fetches GetLinkedProfiles per unresolved member
 *      and POSTs each resolved identity to /api/players/identity.
 *   4. It re-reads GET ?part=active&enrich=1, which joins the now-present players rows.
 *   5. The roster cards repaint: raw membership id → Name#Code, span → link.
 *
 * Three things here are beyond any route-handler test: the page token surviving the
 * RSC boundary across a *chain* of POSTs, the conditional chaining (identity POSTs
 * fire only because unresolvedMemberIds came back non-empty), and the data actually
 * round-tripping through the database into the DOM.
 *
 * The GetLinkedProfiles stub is held behind a gate so the "before" state is a fact
 * rather than a race — without it, resolution can finish before the first assertion
 * runs and the repaint proves nothing.
 *
 * Requires NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY to have been set at build time — see
 * client-write-verify.spec.ts.
 */

// Namespace prefix 84: membership IDs and display names, per convention. The 4001xx
// sub-range keeps clear of 4611686018488400001–400011, which the #62 Vitest route
// tests reserve.
const HOST_ID = '4611686018488400101';
const HOST_NAME = 'HostGuardian84';
const HOST_CODE = 8401;

interface UnknownMember {
    membershipId: string;
    name: string;
    code: number;
}

/** Seeded into the session roster but deliberately NOT into `players`. */
const UNKNOWN_MEMBERS: UnknownMember[] = [
    { membershipId: '4611686018488400102', name: 'RosterAlpha84', code: 8402 },
    { membershipId: '4611686018488400103', name: 'RosterBravo84', code: 8403 },
];

/** The production formatter, so a fixture code under four digits still matches
 *  what the DOM renders (formatBungieDisplayName zero-pads). */
function displayNameOf(member: UnknownMember): string {
    return formatBungieDisplayName({
        membershipId: member.membershipId,
        displayName: member.name,
        bungieGlobalDisplayName: member.name,
        bungieGlobalDisplayNameCode: member.code,
    });
}

test.beforeAll(() => {
    // The host is known; their fireteam is not. The baseline GET therefore paints
    // raw ids before the browser has spoken to Bungie at all.
    seedPlayerWithSession({
        membershipId: HOST_ID,
        name: HOST_NAME,
        code: HOST_CODE,
        raid: RAID_A,
        extraMembers: UNKNOWN_MEMBERS.map((m) => m.membershipId),
    });
});

test.describe('client-write resolve', () => {
    test('names unknown roster members and repaints their cards as clickable Name#Code', async ({ page }) => {
        const log = interceptApiCalls(page);

        // Same roster the seeded session carries, so the POST does not change who is
        // unresolved — only the server's knowledge of the activity.
        const profile = buildActiveProfile({
            membershipId: HOST_ID,
            membershipType: 3,
            displayName: HOST_NAME,
            bungieGlobalDisplayName: HOST_NAME,
            bungieGlobalDisplayNameCode: HOST_CODE,
            partyMembers: [
                { membershipId: HOST_ID, displayName: HOST_NAME, status: 1 },
                // No displayName: the builder falls back to the membership id, which
                // is what Bungie sends for a teammate it has no name for.
                ...UNKNOWN_MEMBERS.map((m) => ({ membershipId: m.membershipId, status: 1 })),
            ],
        });

        // Held until the "before" DOM state has been asserted.
        let releaseLinkedProfiles: () => void = () => undefined;
        const linkedProfilesGate = new Promise<void>((resolve) => {
            releaseLinkedProfiles = resolve;
        });

        const linkedProfileRequests: string[] = [];

        // One handler branching on the URL rather than two overlapping page.route
        // globs: Playwright resolves routes in reverse-registration order, and a
        // second `**/Platform/Destiny2/**` would shadow whichever was registered
        // first. Anything neither endpoint claims falls back to the suite-wide
        // Bungie stub in test-fixtures.ts, so a widened flow cannot silently be
        // served the host's profile.
        await page.route('**/Platform/Destiny2/**', async (route) => {
            const url = route.request().url();

            const linkedProfilesMatch = /\/Profile\/(\d+)\/LinkedProfiles\//.exec(url);
            if (linkedProfilesMatch) {
                const requestedId = linkedProfilesMatch[1];
                linkedProfileRequests.push(requestedId);

                await linkedProfilesGate;

                const member = UNKNOWN_MEMBERS.find((m) => m.membershipId === requestedId);
                await fulfillBungie(route, member
                    ? buildLinkedProfiles({
                        membershipId: member.membershipId,
                        membershipType: 3,
                        bungieGlobalDisplayName: member.name,
                        bungieGlobalDisplayNameCode: member.code,
                    })
                    : {});
                return;
            }

            if (url.includes(`/Profile/${HOST_ID}/`)) {
                await fulfillBungie(route, profile);
                return;
            }

            await route.fallback();
        });

        const queueCrawlDone = waitForQueueCrawl(page);

        await page.goto(`/player/3/${HOST_ID}`);

        // --- Before: raw membership ids, and no link to a player we cannot name ---

        await expect(
            page.getByRole('heading', { level: 3, name: RAID_A.name }),
        ).toBeVisible({ timeout: 10_000 });

        for (const member of UNKNOWN_MEMBERS) {
            await expect(page.getByTitle(member.membershipId)).toBeVisible({ timeout: 10_000 });
            // A span, not a link: ActiveSessionCard only links a member it has a
            // membershipType for, and an unresolved member has none.
            await expect(page.getByRole('link', { name: member.membershipId })).toHaveCount(0);
            await expect(page.getByRole('link', { name: displayNameOf(member) })).toHaveCount(0);
        }

        // The chain reached Bungie — nothing else in the app calls GetLinkedProfiles,
        // so this is proof the POST came back with a non-empty unresolvedMemberIds.
        await expect
            .poll(() => linkedProfileRequests.length, { timeout: 10_000 })
            .toBeGreaterThanOrEqual(1);

        // --- After: identities stored, session re-read enriched, cards repainted ---

        releaseLinkedProfiles();

        for (const member of UNKNOWN_MEMBERS) {
            // A link, not a span: enrich=1 supplied membershipType from `players`,
            // which is what makes the card clickable.
            await expect(
                page.getByRole('link', { name: displayNameOf(member) }),
            ).toBeVisible({ timeout: 10_000 });
            await expect(page.getByTitle(member.membershipId)).toHaveCount(0);
        }

        // Every unresolved member was looked up, and nobody else was.
        expect([...linkedProfileRequests].sort()).toEqual(
            UNKNOWN_MEMBERS.map((m) => m.membershipId).sort(),
        );

        await queueCrawlDone;

        // --- Network sequence ---

        const updateIndex = callIndex(log, 'POST', 'active-session-update');
        const identityIndexes = callIndexes(log, 'POST', '/api/players/identity');
        const enrichIndex = callIndex(log, 'GET', 'enrich=1');

        // active-session-update POST → one identity POST per unresolved member → enrich=1 GET.
        expect(updateIndex).toBeGreaterThanOrEqual(0);
        expect(identityIndexes).toHaveLength(UNKNOWN_MEMBERS.length);
        expect(enrichIndex).toBeGreaterThanOrEqual(0);
        expect(Math.min(...identityIndexes)).toBeGreaterThan(updateIndex);
        expect(enrichIndex).toBeGreaterThan(Math.max(...identityIndexes));

        // Every write in the chain carried the page token across the RSC boundary.
        expect(log[updateIndex].hasPageToken).toBe(true);
        for (const index of identityIndexes) {
            expect(log[index].hasPageToken).toBe(true);
        }

        // queueCrawlOnce still fires on this path, with its token.
        const crawlIndex = callIndex(log, 'POST', 'queue-crawl');
        expect(crawlIndex).toBeGreaterThanOrEqual(0);
        expect(log[crawlIndex].hasPageToken).toBe(true);
    });
});
