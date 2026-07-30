import { beforeEach, vi } from 'vitest';

/**
 * Global network guard.
 *
 * Every outbound call in this codebase goes through `fetch` — the Bungie client
 * (`src/lib/bungie/client.ts`) and the manifest downloader are the only callers.
 * So replacing `fetch` with a thrower is sufficient to catch a test that reaches
 * the real internet, which would burn Bungie API quota and make the suite flaky.
 *
 * A test that legitimately needs `fetch` stubs it with `vi.stubGlobal('fetch', …)`.
 * That records this thrower as the original and restores it afterwards, so the
 * guard is back in place for the next test without any per-file cleanup.
 *
 * Scope note: this does not intercept `node:http`/`node:https` directly. Nothing
 * in `src/` uses them, and adding an http-module shim would be machinery guarding
 * a door nobody walks through.
 */
beforeEach(() => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
        return Promise.reject(
            new Error(
                `Blocked an unstubbed network request to ${url}. ` +
                `Tests must not touch the real network — stub it with vi.stubGlobal('fetch', …).`
            )
        );
    });
});
