import { writeHeaders as buildHeaders, type WriteHeaderOptions } from '../../tests/helpers/write-headers';
import { E2E_BASE_URL } from './server';

/**
 * Client-write headers for POSTs made through Playwright's APIRequestContext.
 *
 * The header contract itself is shared with the Vitest side in
 * tests/helpers/write-headers.ts; this only supplies the origin default, which
 * is the one part that differs — it has to be the port the server was actually
 * started on. `allowedHosts()` adds the request's own Host header, so any
 * origin whose host matches the server's is same-origin and
 * NEXT_PUBLIC_SITE_URL does not have to be set for the run.
 *
 * The minted token verifies on the server because both processes are pinned to
 * E2E_PAGE_TOKEN_SECRET at config load — see e2e/support/fixture-db.ts.
 */

/** An origin that is definitively not this site. */
export const SPOOFED_ORIGIN = 'https://evil.example';

export function writeHeaders({
    origin = E2E_BASE_URL,
    ...rest
}: Partial<WriteHeaderOptions> & Pick<WriteHeaderOptions, 'ip'>): Record<string, string> {
    // Destructured default, not `{ origin: E2E_BASE_URL, ...options }`: an
    // explicit `origin: undefined` would spread over the default and send an
    // `undefined` header value, where `null` is the way to omit the header.
    return buildHeaders({ origin, ...rest });
}
