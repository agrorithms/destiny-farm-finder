import { NextRequest } from 'next/server';
import { mintPageToken } from '../../src/lib/http/request-auth';

export interface WriteRequestOptions {
    origin?: string;
    host?: string;
    ip?: string;
    skipToken?: boolean;
}

/**
 * Constructs a NextRequest suitable for testing the client-write endpoints
 * (identity, queue-crawl, active-session-update). Sets the Origin, page token,
 * and x-forwarded-for headers that isTrustedClientWrite checks.
 */
export function buildWriteRequest(
    path: string,
    body: Record<string, unknown>,
    options: WriteRequestOptions = {}
): NextRequest {
    const {
        origin = 'http://localhost:3100',
        host = 'localhost:3100',
        ip = '1.2.3.4',
        skipToken = false,
    } = options;

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        host,
        origin,
        'x-forwarded-for': ip,
    };

    if (!skipToken) {
        headers['x-page-token'] = mintPageToken();
    }

    return new NextRequest(`http://${host}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}
