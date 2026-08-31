import type { Page } from '@playwright/test';
import { PAGE_TOKEN_HEADER } from '../../src/lib/http/request-auth';

/**
 * Records every browser → app request to /api/players/** in call order.
 *
 * The ordering is the thing Vitest cannot provide: the client-write flows are a
 * chain of conditional, fire-and-forget calls (active-session-update → identity
 * → enriched re-read → queue-crawl), and a route-handler test can only ever see
 * one link of that chain in isolation. `hasPageToken` is recorded per entry
 * because the token surviving the RSC boundary into a real header is itself an
 * assertion no unit test can make.
 *
 * Shared by client-write-verify.spec.ts and client-write-resolve.spec.ts.
 */
export interface NetworkEntry {
    method: string;
    path: string;
    hasPageToken: boolean;
}

/**
 * A pure observer via `page.on`, deliberately not `page.route`.
 *
 * A route handler would claim a slot in Playwright's reverse-registration
 * routing stack for these URLs — so a later spec that needs to *fulfil* an
 * /api/players response would silently stop being logged, and every logged
 * request would be re-issued through `route.continue()`. `page.on('request')`
 * sees everything, conflicts with nothing, and needs no await.
 */
export function interceptApiCalls(page: Page): NetworkEntry[] {
    const log: NetworkEntry[] = [];

    page.on('request', (request) => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/players/')) return;
        log.push({
            method: request.method(),
            path: url.pathname + url.search,
            hasPageToken: PAGE_TOKEN_HEADER in request.headers(),
        });
    });

    return log;
}

/**
 * Positions of the calls matching `method` + a path fragment, in call order.
 * Indexes rather than entries because the assertions are about *sequence* —
 * "the identity POSTs happened after the update POST and before the enriched
 * re-read" is the claim, and only a position can carry it.
 */
export function callIndexes(log: NetworkEntry[], method: string, pathFragment: string): number[] {
    const indexes: number[] = [];
    log.forEach((entry, index) => {
        if (entry.method === method && entry.path.includes(pathFragment)) indexes.push(index);
    });
    return indexes;
}

/** Position of the first matching call, or -1. */
export function callIndex(log: NetworkEntry[], method: string, pathFragment: string): number {
    return log.findIndex((entry) => entry.method === method && entry.path.includes(pathFragment));
}

/**
 * Both client-write specs end on queue-crawl, which is fire-and-forget — the
 * waiter has to be armed before navigating or it can miss the response.
 */
export function waitForQueueCrawl(page: Page) {
    return page.waitForResponse(
        (res) => res.url().includes('/api/players/queue-crawl') && res.request().method() === 'POST',
        { timeout: 15_000 },
    );
}
