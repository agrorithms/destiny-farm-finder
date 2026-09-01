/**
 * Shared Bungie fetch plumbing for the gos10k side project.
 *
 * Extracted verbatim from gos_10k.ts (which now imports it) so the PGCR backfill
 * reuses the exact rate limiter and 429 handling that the history crawl was
 * verified with, rather than growing a second, subtly different copy.
 *
 * Two entry points, because the two callers need different failure semantics:
 *
 *   fetchOk  — throws on ErrorCode !== 1. Right for the history crawl, where a
 *              bad page is indistinguishable from end-of-history and a silent
 *              stop is worse than a crash.
 *   fetchRaw — returns the HTTP status alongside the body and judges nothing.
 *              Right for the PGCR loop, which must tell a broken instance apart
 *              from a broken API (see pgcr-errors.ts).
 */

/** Bungie's documented ceiling is 25 rps; the project runs just under it. */
const MAX_RPS = 25;

/** Bound the 429 retry loop so a persistent throttle fails instead of spinning. */
const MAX_RETRIES = 5;

export class RateLimiter {
    private readonly minIntervalMs: number;
    private lastCallTime = 0;

    constructor(maxRequestsPerSecond: number) {
        const rps = Math.min(Math.max(1, maxRequestsPerSecond), MAX_RPS);
        this.minIntervalMs = 1000 / rps;
    }

    async wait(): Promise<void> {
        const delay = this.minIntervalMs - (Date.now() - this.lastCallTime);
        if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        this.lastCallTime = Date.now();
    }
}

export interface RawFetchResult {
    httpStatus: number;
    body: any;
}

export interface BungieFetch {
    /** Status + body, no judgement. The caller classifies. */
    fetchRaw(url: string, headers: Record<string, string>): Promise<RawFetchResult>;
    /** Throws on any non-success, HTTP or envelope. */
    fetchOk(url: string, headers: Record<string, string>): Promise<any>;
}

export function createBungieFetch(maxRequestsPerSecond: number): BungieFetch {
    const limiter = new RateLimiter(maxRequestsPerSecond);

    async function fetchRaw(
        url: string,
        headers: Record<string, string>,
        attempt = 0
    ): Promise<RawFetchResult> {
        await limiter.wait();

        const res = await fetch(url, { headers });

        // HTTP 429 is the one status worth retrying in place: it is explicitly
        // "you were too fast", not "this request is wrong".
        if (res.status === 429) {
            if (attempt >= MAX_RETRIES) {
                throw new Error(`Still rate limited (HTTP 429) after ${MAX_RETRIES} retries — giving up.`);
            }
            const backoffMs = 2000 * (attempt + 1);
            console.warn(
                `Rate limit hit (HTTP 429)! Backing off ${backoffMs}ms before retry ${attempt + 1}/${MAX_RETRIES}...`
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            return fetchRaw(url, headers, attempt + 1);
        }

        // A non-JSON body is itself information (a Cloudflare error page, say),
        // so failing to parse must not mask the status the caller needs.
        let body: unknown = null;
        try {
            body = await res.json();
        } catch {
            body = null;
        }

        return { httpStatus: res.status, body };
    }

    async function fetchOk(url: string, headers: Record<string, string>): Promise<any> {
        const { httpStatus, body } = await fetchRaw(url, headers);

        if (httpStatus < 200 || httpStatus >= 300) {
            throw new Error(`HTTP Error ${httpStatus}`);
        }

        // Bungie signals most failures as HTTP 200 with ErrorCode != 1 —
        // SystemDisabled (weekly maintenance), DestinyPrivacyRestriction,
        // DestinyThrottledByGameServer. Left unchecked, `body.Response` is
        // undefined, the caller sees an empty list, and a transient API error
        // becomes indistinguishable from "end of history". Same check as
        // src/lib/bungie/client.ts.
        if (body?.ErrorCode !== undefined && body.ErrorCode !== 1) {
            const throttle = body.ThrottleSeconds > 0 ? ` (ThrottleSeconds: ${body.ThrottleSeconds})` : '';
            throw new Error(`Bungie API error ${body.ErrorCode} ${body.ErrorStatus}: ${body.Message}${throttle}`);
        }

        return body;
    }

    return { fetchRaw, fetchOk };
}
