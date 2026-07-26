import { describe, expect, it } from 'vitest';
import { BungieAPIError } from './client';
import { isBungieSystemDisabledError } from './maintenance';

/**
 * This predicate decides whether the crawler and scanner pause for Bungie's
 * weekly maintenance window or keep hammering a dead API. The cost of a false
 * negative is thousands of doomed requests; the cost of a false positive is a
 * needless multi-minute pause during an ordinary blip. Both matter, so the
 * negative cases below are as important as the positive one.
 */
describe('isBungieSystemDisabledError', () => {
    it('recognises Bungie signalling that the platform is down for maintenance', () => {
        const error = new BungieAPIError(5, 'SystemDisabled', 'This system is temporarily disabled.');

        expect(isBungieSystemDisabledError(error)).toBe(true);
    });

    it('ignores a different Bungie-level error', () => {
        // A privacy restriction is a per-player condition, not a platform outage.
        // Pausing the whole crawler for one private profile would be a real bug.
        const error = new BungieAPIError(1665, 'DestinyPrivacyRestriction', 'Profile is private.');

        expect(isBungieSystemDisabledError(error)).toBe(false);
    });

    it('ignores a plain HTTP failure', () => {
        // request() throws a generic Error for non-2xx responses, so a 500 never
        // reaches here as a BungieAPIError. Bungie 5xx storms are common and must
        // not be mistaken for scheduled maintenance.
        const error = new Error('Bungie API error 500: <html>Internal Server Error</html>');

        expect(isBungieSystemDisabledError(error)).toBe(false);
    });

    it('ignores a request timeout', () => {
        const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

        expect(isBungieSystemDisabledError(error)).toBe(false);
    });

    it('ignores an error-shaped object that merely claims the right status', () => {
        // The check is instanceof-based, so a plain object carrying the same
        // fields is deliberately not enough.
        const impostor = { name: 'BungieAPIError', errorCode: 5, errorStatus: 'SystemDisabled' };

        expect(isBungieSystemDisabledError(impostor)).toBe(false);
    });

    it('ignores non-errors entirely', () => {
        expect(isBungieSystemDisabledError(null)).toBe(false);
        expect(isBungieSystemDisabledError(undefined)).toBe(false);
        expect(isBungieSystemDisabledError('SystemDisabled')).toBe(false);
    });
});
