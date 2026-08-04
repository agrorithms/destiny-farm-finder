import { expect, test } from '@playwright/test';
import { canaryDisplayName, canaryName } from './seed-world';

/**
 * The one check that *observes* which database the running server opened,
 * rather than reasoning about configuration.
 *
 * Two layers already guard the fixture database: assertDbPathAllowed() in
 * src/lib/db/index.ts, and the fail-fast in playwright.config.ts. Both reason
 * about env vars, and neither can fire if the env never reaches the `next start`
 * child — which is exactly the failure they exist to prevent, and it would end
 * with the server reading the live 5.5 GB database. This asks the server.
 *
 * Runs as a project dependency, so it is guaranteed to complete before any spec
 * and its failure aborts the run instead of producing four confusing failures.
 */
test('the server is serving this run\'s fixture database', async ({ request }) => {
    const expected = canaryDisplayName();

    // /api/players/search reads local SQLite only — no Bungie call — and is
    // no-store, so a hit cannot be a cache artefact.
    // Query the bare name, not the Name#Code form, so this check does not also
    // depend on how the search endpoint parses a discriminator.
    const response = await request.get(`/api/players/search?query=${encodeURIComponent(canaryName())}`);
    expect(response.ok(), 'player search should respond').toBe(true);

    const body = await response.json() as { results?: Array<{ displayName: string }> };
    const names = (body.results ?? []).map((result) => result.displayName);

    // The canary name carries a per-run nonce. A server left over from an
    // earlier run holds the *previous* run's canary, so this fails loudly rather
    // than letting every spec read a stale database.
    expect(
        names,
        'the running server is not reading this run\'s fixture database — it may be a stale ' +
        'server from an earlier run, or the fixture env did not reach `next start`'
    ).toContain(expected);
});
