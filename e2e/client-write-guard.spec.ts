import { expect, test } from './support/test-fixtures';
import { SPOOFED_ORIGIN, writeHeaders } from './support/write-request';

/**
 * The request-authenticity guard, exercised over real HTTP against the running
 * server. Issue #24.
 *
 * What this adds over what already exists. src/lib/http/request-auth.test.ts
 * covers the guard's *logic* (28 tests) and tests/routes/*.test.ts covers the
 * 403 branch by calling each exported POST directly with a spoofed-origin
 * NextRequest. Neither goes through the HTTP stack, and one thing lives only
 * there: middleware.ts matches `/api/players/:path*`, which covers all three
 * client-write endpoints, and its rate limiter runs *before* the route's guard.
 * A request rejected by middleware never reaches isTrustedClientWrite at all.
 * So every negative below asserts the response body, not just the status —
 * `{error:'Forbidden'}` is what distinguishes the guard's 403 from middleware's
 * 429 or 401. See issue #66 for the bucket question that finding raised.
 *
 * Every request here goes through APIRequestContext, not a page. The `test`
 * import is still the fixtures one, per the suite-wide convention that no spec
 * imports from '@playwright/test' directly — note that its network guard is an
 * `auto` fixture depending on `page`, so a browser page is still created per
 * test and nothing routes through it. Costs a little time, keeps one rule.
 *
 * No seeding. upsertPlayerFillOnly is a plain INSERT for a membership id the
 * database has not seen, so the positive control only needs an unused id.
 */

// Namespace prefix 85 (81 = active-sessions-cap, 82 = player-names,
// 83 = client-write-verify, 84 = client-write-resolve), per the convention in
// docs/handoffs/260803-playwright-e2e.md §2.
const CONTROL_ID = '4611686018488500001';
const CONTROL_NAME = 'GuardControl85';
const CONTROL_CODE = 8501;

const identityBody = {
    membershipId: CONTROL_ID,
    membershipType: 3,
    bungieGlobalDisplayName: CONTROL_NAME,
    bungieGlobalDisplayNameCode: CONTROL_CODE,
};

// Well-formed bodies on the negatives too. The guard runs before request.json(),
// so an empty body would 403 either way — but if the guard were ever deleted,
// a valid body makes the test fail as a *successful write* rather than as a 400
// that reads like a body problem.
const queueCrawlBody = {
    membershipId: CONTROL_ID,
    membershipType: 3,
    displayName: CONTROL_NAME,
};

const activeSessionUpdateBody = {
    membershipId: CONTROL_ID,
    membershipType: 3,
    profileResponse: { profileTransitoryData: { data: {} } },
};

test.describe('client-write guard over HTTP', () => {
    // The positive control. Without it a 403 proves nothing: a typo'd path or a
    // guard that rejects everything would read as green.
    //
    // Asserts the body, not just "not 403": the cooldown branch of this endpoint
    // returns HTTP 200 with {stored:false, reason:'recently_updated'}, so a
    // status-only assertion is satisfied by a request that did nothing at all.
    // {stored:true} is proof the request reached the handler body past both the
    // guard and the cooldown.
    test('valid origin and token: the write lands', async ({ request }) => {
        const response = await request.post('/api/players/identity', {
            headers: writeHeaders({ ip: '85.0.0.1' }),
            data: identityBody,
        });

        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ stored: true });
    });

    test('spoofed origin is rejected by the guard, not by middleware', async ({ request }) => {
        const response = await request.post('/api/players/identity', {
            headers: writeHeaders({ origin: SPOOFED_ORIGIN, ip: '85.0.0.2' }),
            data: identityBody,
        });

        expect(response.status()).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
    });

    // APIRequestContext sends no Origin of its own, so omitting it also leaves
    // Referer unset — the both-headers-absent case isSameOrigin() falls through
    // to. A browser would not normally produce this; a scripted client does.
    test('no origin and no referer is rejected', async ({ request }) => {
        const response = await request.post('/api/players/identity', {
            headers: writeHeaders({ origin: null, ip: '85.0.0.3' }),
            data: identityBody,
        });

        expect(response.status()).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
    });

    // The token layer is on. This is the case that would go green for the wrong
    // reason if no PAGE_TOKEN_SECRET reached the server at all — verifyPageToken()
    // fails open without one, and a tokenless request would then be allowed
    // through to a 200. It guards the pin in e2e/support/fixture-db.ts as much as
    // it guards the endpoint.
    test('valid origin with no page token is rejected', async ({ request }) => {
        const response = await request.post('/api/players/identity', {
            headers: writeHeaders({ token: null, ip: '85.0.0.4' }),
            data: identityBody,
        });

        expect(response.status()).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
    });

    // The two smokes below prove the guard is installed on every client-write
    // surface, not just the one the matrix above exercises.
    test('queue-crawl carries the guard', async ({ request }) => {
        const response = await request.post('/api/players/queue-crawl', {
            headers: writeHeaders({ origin: SPOOFED_ORIGIN, ip: '85.0.0.5' }),
            data: queueCrawlBody,
        });

        expect(response.status()).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
    });

    test('active-session-update carries the guard', async ({ request }) => {
        const response = await request.post('/api/players/active-session-update', {
            headers: writeHeaders({ origin: SPOOFED_ORIGIN, ip: '85.0.0.6' }),
            data: activeSessionUpdateBody,
        });

        expect(response.status()).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
    });
});
