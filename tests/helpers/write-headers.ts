import { PAGE_TOKEN_HEADER, mintPageToken } from '../../src/lib/http/request-auth';

/**
 * The header contract isTrustedClientWrite checks, in one place.
 *
 * Both runners need it and neither can use the other's request object: Vitest
 * hands a `NextRequest` straight to an exported route handler, Playwright sends
 * real HTTP through APIRequestContext. What they share is exactly this map, so
 * a new required header is one edit rather than two — and a missed second edit
 * would surface as a 403 that reads like a guard bug.
 *
 * Lives in tests/helpers/ because both runners load from here: no `vitest`
 * import, relative paths only (Playwright's loader does not apply tsconfig
 * `paths`). request-auth.ts pulls in only `crypto` and a type-only
 * `next/server` import, so it is safe in the Playwright runner.
 */

export interface WriteHeaderOptions {
    /** Pass `null` to omit the header entirely, which also omits Referer — the
     *  no-origin-at-all case isSameOrigin() falls through to. */
    origin: string | null;
    /**
     * Sets x-forwarded-for. Both middleware.ts and src/lib/http/request-ip.ts
     * resolve the client IP the same way (cf-connecting-ip, then the first
     * x-forwarded-for entry), so this one header isolates a test case from every
     * rate limiter in the stack. Give each case its own value: the limiters are
     * per-process singletons in the server that no database reset can reach.
     */
    ip: string;
    /** Sends no page-token header at all. Otherwise a freshly minted valid one
     *  is included; mintPageToken() reads process.env.PAGE_TOKEN_SECRET. */
    omitToken?: boolean;
}

export function writeHeaders({ origin, ip, omitToken = false }: WriteHeaderOptions): Record<string, string> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
    };

    if (origin !== null) headers.origin = origin;
    if (!omitToken) headers[PAGE_TOKEN_HEADER] = mintPageToken();

    return headers;
}
