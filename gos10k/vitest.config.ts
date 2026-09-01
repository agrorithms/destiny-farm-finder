import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * A second, deliberately separate Vitest config for gos10k/.
 *
 * The root vitest.config.ts scopes `include` to src/ and tests/, so nothing in
 * this directory is picked up by `npm test` — and therefore nothing here runs in
 * CI. That is intended: gos10k/ is a one-time side project against a standalone
 * database, and a CI job that fails because a throwaway script's fixture drifted
 * would be pure noise on the main app's pipeline.
 *
 * The consequence is that a bare `npx vitest run gos10k/...` does NOT work: a
 * path argument filters within the root config's `include`, it does not extend
 * it. Run these with:
 *
 *     npx vitest run --config gos10k/vitest.config.ts
 *
 * no-network.ts is re-declared rather than inherited. It is the guard that fails
 * any test reaching the real internet, which matters more here than anywhere
 * else in the repo: this directory's scripts hit Bungie ~10k times, and a test
 * that quietly made live calls would burn quota and go flaky.
 *
 * test-db-path.ts is deliberately NOT included. It exists to stop the suite
 * binding to data/raid-tracker.db via getDb(); nothing in gos10k/ imports the
 * app's db module — it opens its own standalone file — so that setup would be
 * machinery guarding a door nobody walks through.
 */
export default defineConfig({
    // Required, and not merely tidy: `root` defaults to the *cwd*, not to this
    // file's directory. Without it, `include` below globs the entire repo and
    // drags in src/ and tests/ — which then fail on the getDb() sentinel guard
    // because this config does not mint a throwaway database. Pinning root here
    // is what keeps the two suites from colliding.
    root: __dirname,
    test: {
        environment: 'node',
        include: ['**/*.test.ts'],
        setupFiles: [path.resolve(__dirname, '../tests/setup/no-network.ts')],
    },
});
