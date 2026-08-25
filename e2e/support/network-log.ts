import type { Page } from '@playwright/test';

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

export async function interceptApiCalls(page: Page, log: NetworkEntry[]): Promise<void> {
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

/**
 * Positions of the calls matching `method` + a path fragment, in call order.
 * Indexes rather than entries because the assertions are about *sequence* —
 * "the identity POSTs happened after the update POST and before the enriched
 * re-read" is the claim, and only a position can carry it.
 */
export function callIndexes(log: NetworkEntry[], method: string, pathFragment: string): number[] {
    return log
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.method === method && entry.path.includes(pathFragment))
        .map(({ index }) => index);
}

/** Position of the first matching call, or -1. */
export function callIndex(log: NetworkEntry[], method: string, pathFragment: string): number {
    return callIndexes(log, method, pathFragment)[0] ?? -1;
}
