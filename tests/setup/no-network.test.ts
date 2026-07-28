import { describe, expect, it, vi } from 'vitest';

// Tests the guard in ./no-network.ts. A silently-broken network guard is worse
// than none: the suite would look protected while quietly hitting the real
// Bungie API, burning quota and going flaky against live data.
describe('the global network guard', () => {
    it('rejects a fetch that no test has stubbed', async () => {
        await expect(fetch('https://stats.bungie.net/Platform/Destiny2/')).rejects.toThrow(
            /Blocked an unstubbed network request/
        );
    });

    it('names the blocked URL so the offending call is findable', async () => {
        await expect(fetch('https://www.bungie.net/some/path')).rejects.toThrow(
            'https://www.bungie.net/some/path'
        );
    });

    it('steps aside for a test that stubs fetch deliberately', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}')));

        const response = await fetch('https://stats.bungie.net/Platform/Destiny2/');

        expect(await response.text()).toBe('{"ok":true}');
    });

    it('is back in force for the test after a stub', async () => {
        // Guards against a leaked stub from the previous test: the beforeEach in
        // no-network.ts must re-arm the thrower even though vi.stubGlobal was
        // called and never explicitly unstubbed.
        await expect(fetch('https://stats.bungie.net/Platform/Destiny2/')).rejects.toThrow(
            /Blocked an unstubbed network request/
        );
    });
});
