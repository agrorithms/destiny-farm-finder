import { NextRequest } from 'next/server';
import { writeHeaders } from './write-headers';

// Arbitrary stand-in: nothing here opens a socket, so this host only has to be
// self-consistent between the URL and the Origin. It does not need to track the
// e2e suite's real port (e2e/support/server.ts).
const HOST = 'localhost:3100';

export interface WriteRequestOptions {
    /** Defaults to the trusted same-origin value; override to test the 403 path. */
    origin?: string;
    /** Sets x-forwarded-for, which the per-IP rate limiters key on. */
    ip?: string;
}

/**
 * Constructs a NextRequest suitable for testing the client-write endpoints
 * (identity, queue-crawl, active-session-update). The Origin, page token, and
 * x-forwarded-for headers that isTrustedClientWrite checks come from
 * ./write-headers.ts, shared with the Playwright side.
 *
 * `body` takes a raw string as well as an object so the invalid-JSON branch can
 * be exercised through the same header set as every other test — a second,
 * hand-rolled NextRequest would drift the moment the trust guard changes.
 */
export function buildWriteRequest(
    path: string,
    body: Record<string, unknown> | string,
    options: WriteRequestOptions = {}
): NextRequest {
    const { origin = `http://${HOST}`, ip = '1.2.3.4' } = options;

    return new NextRequest(`http://${HOST}${path}`, {
        method: 'POST',
        headers: {
            ...writeHeaders({ origin, ip }),
            host: HOST,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}
