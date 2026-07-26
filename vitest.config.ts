import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Vitest over Jest: it runs TypeScript and ESM natively with no babel or ts-jest
// layer, and it does not contend with Next.js 16's bundler. Nothing here is
// clever — every setting is spelled out rather than inferred, because this repo
// had no test framework before and the config should be readable cold.
export default defineConfig({
    test: {
        // The data pipeline is all Node: SQLite, fetch, timers. No DOM, ever.
        environment: 'node',

        // Two homes on purpose. Pure-logic tests sit next to the code they cover
        // so they move with it; anything needing a database or fixtures lives
        // under tests/ where the helpers are.
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],

        // Fails any test that reaches for the network without stubbing fetch. A
        // suite that quietly hits stats.bungie.net burns API quota and goes flaky.
        setupFiles: ['tests/setup/no-network.ts'],

        coverage: {
            provider: 'v8',
            reporter: ['text'],
            // Deliberately no thresholds. Coverage is a diagnostic here, not a gate.
        },
    },

    resolve: {
        // Mirrors the `@/*` -> `./src/*` mapping in tsconfig.json. Kept as an
        // explicit alias rather than a tsconfig-paths plugin so there is one
        // fewer dependency doing something invisible.
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});
