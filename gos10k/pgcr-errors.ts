/**
 * Failure classification for the PGCR backfill loop.
 *
 * Pure on purpose — the decision "abort the run or record this row and carry on"
 * is the one that decides whether an interrupted crawl is recoverable, so it is
 * worth testing without a network in the way.
 */

export type PgcrOutcome =
    /** Parse and store it. */
    | { kind: 'ok'; status: 'ok' }
    /** A property of this instance. Record `status` on the row, keep going. */
    | { kind: 'instance'; status: string }
    /** A property of the API or our credentials. Stop the run. */
    | { kind: 'fatal'; status: string };

/**
 * Bungie error codes that say something about the *service*, not the instance.
 *
 * Recording any of these per-row would be the silent-stop failure the handoff
 * warns about: the loop would sail through the remaining rows in seconds,
 * writing a permanent-looking failure for what was really a maintenance window,
 * and then print a summary that reads like a completed run.
 */
const FATAL_ERROR_CODES = new Set<number>([
    5, // SystemDisabled — weekly maintenance
    51, // PerEndpointRequestThrottleExceeded
    1672, // DestinyThrottledByGameServer (arrives with ThrottleSeconds: 0)
]);

/** Permanent, instance-specific, and worth its own bucket in the report. */
const PRIVACY_ERROR_CODES = new Set<number>([
    1665, // DestinyPrivacyRestriction
]);

interface BungieEnvelope {
    ErrorCode?: number;
    ErrorStatus?: string;
    Message?: string;
    ThrottleSeconds?: number;
    Response?: unknown;
}

export function classifyPgcrOutcome(
    httpStatus: number,
    body: BungieEnvelope | null | undefined
): PgcrOutcome {
    // HTTP layer first — a 404 body is not a Bungie envelope.
    if (httpStatus === 404) {
        return { kind: 'instance', status: 'missing' };
    }
    if (httpStatus === 401 || httpStatus === 403) {
        // Almost certainly the API key. Continuing would mark every remaining
        // row failed for a reason that has nothing to do with the data.
        return { kind: 'fatal', status: `http:${httpStatus}` };
    }
    if (httpStatus >= 500) {
        return { kind: 'fatal', status: `http:${httpStatus}` };
    }
    if (httpStatus !== 200) {
        return { kind: 'instance', status: `http:${httpStatus}` };
    }

    const code = body?.ErrorCode;

    if (code !== undefined && code !== 1) {
        if (FATAL_ERROR_CODES.has(code)) {
            return { kind: 'fatal', status: `error:${code}` };
        }
        if (PRIVACY_ERROR_CODES.has(code)) {
            return { kind: 'instance', status: 'privacy' };
        }
        // Unknown codes are treated as instance-scoped so one oddity cannot end
        // the run — but the code is kept in the status string, so a systemic
        // problem shows up as a spike of one value in the final breakdown and
        // `--retry-failed` can go back for them.
        return { kind: 'instance', status: `error:${code}` };
    }

    if (!body?.Response) {
        // ErrorCode 1 with nothing in it. Parsing `undefined` would write a row
        // of invented nulls; admitting it did not arrive is strictly better.
        return { kind: 'instance', status: 'missing' };
    }

    return { kind: 'ok', status: 'ok' };
}
