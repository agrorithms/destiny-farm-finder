import { PAGE_TOKEN_HEADER, mintPageToken } from '../../src/lib/http/request-auth';
import { E2E_BASE_URL } from './server';

/**
 * Header builder for client-write POSTs made through Playwright's
 * APIRequestContext — no browser page involved.
 *
 * The Vitest equivalent, tests/helpers/build-write-request.ts, cannot be reused:
 * it constructs a `NextRequest` to hand straight to an exported route handler,
 * which is the wrong object when the request is going over real HTTP. What the
 * two share is the header contract, and that lives in request-auth.ts, imported
 * here by *relative* path — Playwright's loader does not apply tsconfig `paths`
 * to files reached from the config. The module pulls in only `crypto` and a
 * type-only `next/server` import, so loading it in the runner is safe.
 *
 * mintPageToken() reads process.env.PAGE_TOKEN_SECRET, which
 * pinPageTokenSecret() sets to E2E_PAGE_TOKEN_SECRET at config load — the same literal the server
 * under test is started with. A token minted here therefore verifies there.
 */

/**
 * The origin the guard trusts. `allowedHosts()` adds the request's own Host
 * header, so any origin whose host matches the server's is same-origin —
 * NEXT_PUBLIC_SITE_URL does not have to be set for the run. Derived from
 * ./server so it cannot drift from the port the server is actually started on.
 */
export const TRUSTED_ORIGIN = E2E_BASE_URL;

/** An origin that is definitively not this site. */
export const SPOOFED_ORIGIN = 'https://evil.example';

export interface WriteHeaderOptions {
    /** Defaults to the trusted same-origin value. Pass `null` to omit the header
     *  entirely, which also omits Referer — the no-origin-at-all case. */
    origin?: string | null;
    /** Defaults to a freshly minted, valid token. Pass `null` to omit the header. */
    token?: string | null;
    /**
     * Sets x-forwarded-for. Both middleware.ts and src/lib/http/request-ip.ts
     * resolve the client IP the same way (cf-connecting-ip, then the first
     * x-forwarded-for entry), so this one header isolates a test case from every
     * rate limiter in the stack. Give each case its own value: the limiters are
     * per-process singletons in the server that no database reset can reach.
     */
    ip: string;
}

export function writeHeaders(options: WriteHeaderOptions): Record<string, string> {
    const { origin = TRUSTED_ORIGIN, token, ip } = options;

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
    };

    if (origin !== null) headers.origin = origin;

    // `undefined` means "mint a valid one"; `null` means "send no token header".
    const resolvedToken = token === undefined ? mintPageToken() : token;
    if (resolvedToken !== null) headers[PAGE_TOKEN_HEADER] = resolvedToken;

    return headers;
}
