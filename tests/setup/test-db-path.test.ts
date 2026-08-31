import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_PATH } from '@/lib/db';

// Tests the invariant that ./test-db-path.ts exists to establish: this process
// is pointed at a throwaway database, not the real one. Both assertions target
// the failure mode that *hides* — a guard that is silently inert. The opposite
// case needs no test: a guard that wrongly refuses breaks every other test file
// at once, loudly.
describe('the test database path', () => {
    it('is pointed at a throwaway database, not the real one', () => {
        expect(DB_PATH).toBe(path.resolve(process.env.DFF_TEST_DB_SENTINEL!));
    });

    it('has the condition set that arms the guard in getDb()', () => {
        // assertDbPathAllowed() is a no-op when VITEST is unset. If some future
        // runner stops setting it, the guard disappears without a sound — so
        // assert the trigger itself, not just the path it protects.
        expect(process.env.VITEST).toBeTruthy();
    });
});
