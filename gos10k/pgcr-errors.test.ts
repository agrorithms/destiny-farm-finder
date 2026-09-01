import { describe, expect, it } from 'vitest';
import { classifyPgcrOutcome } from './pgcr-errors';

/**
 * Gotcha 3 from the handoff, made executable.
 *
 * Bungie returns HTTP 200 with ErrorCode !== 1 for most failures, so `res.ok`
 * proves nothing. The distinction that matters for a 10k-request loop is not
 * "did it work" but "is this instance broken, or is the API broken":
 *
 *   - instance broken  -> record the status, move on, 9,999 rows still land
 *   - API broken       -> abort, because continuing would stamp thousands of
 *                         rows with a permanent-looking failure that was really
 *                         a five-minute maintenance window
 *
 * Getting that backwards is the expensive mistake: the run "completes", the
 * report looks plausible, and the damage is only visible months later.
 */

describe('classifyPgcrOutcome', () => {
    it('accepts a successful response', () => {
        const outcome = classifyPgcrOutcome(200, { ErrorCode: 1, Response: { entries: [] } });
        expect(outcome).toEqual({ kind: 'ok', status: 'ok' });
    });

    it('treats maintenance as fatal, not as a per-instance failure', () => {
        // Weekly Tuesday maintenance. If this were recorded per-instance the
        // loop would burn through every remaining row in minutes, marking them
        // all failed, and --retry-failed would be the only way back.
        const outcome = classifyPgcrOutcome(200, {
            ErrorCode: 5,
            ErrorStatus: 'SystemDisabled',
            Message: 'This system is temporarily disabled for maintenance.',
        });
        expect(outcome.kind).toBe('fatal');
    });

    it('treats game-server throttling as fatal', () => {
        // ErrorCode 1672 arrives with ThrottleSeconds: 0, so there is nothing to
        // sleep on. Stopping is the only honest response.
        const outcome = classifyPgcrOutcome(200, {
            ErrorCode: 1672,
            ErrorStatus: 'DestinyThrottledByGameServer',
            ThrottleSeconds: 0,
        });
        expect(outcome.kind).toBe('fatal');
    });

    it('treats per-endpoint throttling as fatal', () => {
        const outcome = classifyPgcrOutcome(200, {
            ErrorCode: 51,
            ErrorStatus: 'PerEndpointRequestThrottleExceeded',
        });
        expect(outcome.kind).toBe('fatal');
    });

    it('records a privacy restriction against the instance and continues', () => {
        // A genuinely permanent property of that PGCR — retrying will never help,
        // so it must be distinguishable from a transient error in the report.
        const outcome = classifyPgcrOutcome(200, {
            ErrorCode: 1665,
            ErrorStatus: 'DestinyPrivacyRestriction',
        });
        expect(outcome).toEqual({ kind: 'instance', status: 'privacy' });
    });

    it('records an unrecognised Bungie error code against the instance', () => {
        // Keeping the code in the status string is the point: an unknown failure
        // that turns out to be systemic is then visible as a spike of one value
        // in the final breakdown rather than an undifferentiated "error".
        const outcome = classifyPgcrOutcome(200, {
            ErrorCode: 1653,
            ErrorStatus: 'DestinyAccountNotFound',
        });
        expect(outcome).toEqual({ kind: 'instance', status: 'error:1653' });
    });

    it('records a 404 as a missing PGCR', () => {
        const outcome = classifyPgcrOutcome(404, null);
        expect(outcome).toEqual({ kind: 'instance', status: 'missing' });
    });

    it('treats a 5xx as fatal', () => {
        // Bungie being down is not a property of this instance.
        expect(classifyPgcrOutcome(503, null).kind).toBe('fatal');
        expect(classifyPgcrOutcome(500, null).kind).toBe('fatal');
    });

    it('treats a 401/403 as fatal', () => {
        // A bad or revoked API key would otherwise mark all 10k rows failed.
        expect(classifyPgcrOutcome(401, null).kind).toBe('fatal');
        expect(classifyPgcrOutcome(403, null).kind).toBe('fatal');
    });

    it('records a success envelope with no Response body as missing', () => {
        // ErrorCode 1 but nothing in it. Writing a parse of `undefined` would be
        // worse than admitting the PGCR did not arrive.
        const outcome = classifyPgcrOutcome(200, { ErrorCode: 1 });
        expect(outcome).toEqual({ kind: 'instance', status: 'missing' });
    });
});
