import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PAGE_TOKEN_HEADER,
    isSameOrigin,
    isTrustedClientWrite,
    mintPageToken,
    verifyPageToken,
} from './request-auth';

/**
 * The only thing standing between the client-write endpoints
 * (active-session-update, identity, queue-crawl) and anyone with curl. It had no
 * coverage. This file pins both layers described in the module header: the
 * same-origin check, and the short-lived HMAC page token.
 *
 * Note the deliberate fail-open in the token layer — with no PAGE_TOKEN_SECRET
 * configured, verifyPageToken returns true and only the same-origin check
 * applies. That is documented behaviour, not a bug, so it is pinned here to stop
 * anyone "fixing" it into a fail-closed that would 403 every write in any
 * deployment where the secret is unset.
 */

const SECRET = 'test-secret-not-a-real-credential';
const T0 = new Date('2026-08-03T12:00:00Z').getTime();

/** A request carrying only the headers the guard actually reads. */
function requestWith(headers: Record<string, string>): NextRequest {
    return new NextRequest('http://localhost:3100/api/players/identity', {
        method: 'POST',
        headers,
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    // Never inherit the developer's real values — both are read at call time.
    vi.stubEnv('PAGE_TOKEN_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://destinyfarmfinder.qzz.io');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('mintPageToken / verifyPageToken', () => {
    it('accepts a token it just minted', () => {
        expect(verifyPageToken(mintPageToken())).toBe(true);
    });

    it('rejects a token whose expiry has passed', () => {
        const token = mintPageToken(15 * 60_000);

        vi.setSystemTime(T0 + 15 * 60_000 + 1);
        expect(verifyPageToken(token)).toBe(false);
    });

    it('still accepts a token in its final millisecond', () => {
        // Guards against an off-by-one turning the TTL into TTL-minus-one.
        const token = mintPageToken(15 * 60_000);

        vi.setSystemTime(T0 + 15 * 60_000 - 1);
        expect(verifyPageToken(token)).toBe(true);
    });

    it('rejects a token whose signature was tampered with', () => {
        const token = mintPageToken();
        const [expiry, signature] = token.split('.');
        const tampered = `${expiry}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

        expect(verifyPageToken(tampered)).toBe(false);
    });

    it('rejects a token whose expiry was extended without re-signing', () => {
        // The attack the HMAC exists to stop: take a real token, push the expiry
        // out, keep the old signature.
        const token = mintPageToken();
        const signature = token.slice(token.indexOf('.') + 1);
        const forged = `${T0 + 86_400_000}.${signature}`;

        expect(verifyPageToken(forged)).toBe(false);
    });

    it('rejects a token signed with a different secret', () => {
        const token = mintPageToken();

        vi.stubEnv('PAGE_TOKEN_SECRET', 'a-completely-different-secret');
        expect(verifyPageToken(token)).toBe(false);
    });

    it.each([
        ['empty string', ''],
        ['null', null],
        ['undefined', undefined],
        ['no separator', 'notatoken'],
        ['leading separator', '.signature'],
        ['non-numeric expiry', 'abc.signature'],
        ['expiry only', '1234567890.'],
    ])('rejects a malformed token (%s)', (_label, token) => {
        expect(verifyPageToken(token)).toBe(false);
    });

    describe('when PAGE_TOKEN_SECRET is unset', () => {
        beforeEach(() => {
            vi.stubEnv('PAGE_TOKEN_SECRET', '');
        });

        it('mints an empty token', () => {
            expect(mintPageToken()).toBe('');
        });

        it('fails open, so the token layer is simply disabled', () => {
            expect(verifyPageToken('')).toBe(true);
            expect(verifyPageToken('anything-at-all')).toBe(true);
        });
    });
});

describe('isSameOrigin', () => {
    it('accepts an Origin matching the request Host', () => {
        // This is what makes any deploy domain — and the e2e server on port
        // 3100 — work without configuration.
        const request = requestWith({
            host: 'localhost:3100',
            origin: 'http://localhost:3100',
        });
        expect(isSameOrigin(request)).toBe(true);
    });

    it('accepts an Origin matching NEXT_PUBLIC_SITE_URL', () => {
        const request = requestWith({
            host: 'internal-upstream:8080',
            origin: 'https://destinyfarmfinder.qzz.io',
        });
        expect(isSameOrigin(request)).toBe(true);
    });

    it('accepts the hardcoded dev origin', () => {
        const request = requestWith({
            host: 'internal-upstream:8080',
            origin: 'http://localhost:3000',
        });
        expect(isSameOrigin(request)).toBe(true);
    });

    it('rejects a cross-origin request', () => {
        const request = requestWith({
            host: 'localhost:3100',
            origin: 'https://evil.example.com',
        });
        expect(isSameOrigin(request)).toBe(false);
    });

    it('falls back to Referer when Origin is absent', () => {
        // Some browsers omit Origin on same-origin requests.
        const request = requestWith({
            host: 'localhost:3100',
            referer: 'http://localhost:3100/player/3/456',
        });
        expect(isSameOrigin(request)).toBe(true);
    });

    it('rejects a cross-origin Referer', () => {
        const request = requestWith({
            host: 'localhost:3100',
            referer: 'https://evil.example.com/attack',
        });
        expect(isSameOrigin(request)).toBe(false);
    });

    it('ignores Referer when Origin is present and wrong', () => {
        // Origin wins outright — a matching Referer must not rescue a bad Origin,
        // or the fallback becomes a bypass.
        const request = requestWith({
            host: 'localhost:3100',
            origin: 'https://evil.example.com',
            referer: 'http://localhost:3100/player/3/456',
        });
        expect(isSameOrigin(request)).toBe(false);
    });

    it('rejects a request with neither Origin nor Referer', () => {
        // Plain scripted POSTs land here.
        expect(isSameOrigin(requestWith({ host: 'localhost:3100' }))).toBe(false);
    });

    it('rejects an unparseable Origin', () => {
        const request = requestWith({ host: 'localhost:3100', origin: 'not a url' });
        expect(isSameOrigin(request)).toBe(false);
    });
});

describe('isTrustedClientWrite', () => {
    it('allows a same-origin request carrying a valid token', () => {
        const request = requestWith({
            host: 'localhost:3100',
            origin: 'http://localhost:3100',
            [PAGE_TOKEN_HEADER]: mintPageToken(),
        });
        expect(isTrustedClientWrite(request)).toBe(true);
    });

    it('rejects a same-origin request with no token', () => {
        const request = requestWith({
            host: 'localhost:3100',
            origin: 'http://localhost:3100',
        });
        expect(isTrustedClientWrite(request)).toBe(false);
    });

    it('rejects a cross-origin request even with a valid token', () => {
        // The token is minted server-side into a real page, so an attacker who
        // scrapes one must still fail the origin check.
        const request = requestWith({
            host: 'localhost:3100',
            origin: 'https://evil.example.com',
            [PAGE_TOKEN_HEADER]: mintPageToken(),
        });
        expect(isTrustedClientWrite(request)).toBe(false);
    });

    it('rejects a cross-origin request when the token layer is disabled', () => {
        // With no secret the token check fails open, so the same-origin check is
        // the only thing left — it must still hold on its own.
        vi.stubEnv('PAGE_TOKEN_SECRET', '');
        const request = requestWith({
            host: 'localhost:3100',
            origin: 'https://evil.example.com',
        });
        expect(isTrustedClientWrite(request)).toBe(false);
    });
});
