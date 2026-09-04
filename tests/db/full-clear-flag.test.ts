import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { readPgcrRow, seedRun } from '../helpers/seed';

/**
 * What actually decides whether a run counts as a full clear.
 *
 * There used to be two candidate signals in the codebase, only one of them real:
 *
 *   ProcessedPGCR.isFullClear         computed, never persisted, always true
 *   pgcrs.activity_was_started_from_beginning   persisted, and what every
 *                                               leaderboard filters on
 *
 * The first was dead code and has been deleted. Bungie reports
 * `startingPhaseIndex: 0` on every PGCR, including confirmed checkpoint runs
 * (see tests/real-pgcrs.test.ts), so `isFullClear`'s `=== 0` branch fired
 * unconditionally and reported every run as a full clear — including the 568k
 * that are checkpoint runs. Nothing read it, so nothing broke; wiring it up
 * would have inflated every leaderboard by roughly 2.2x.
 *
 * These tests pin the signal that ships, so that if anyone ever "tidies" the
 * writer by using the derived field instead, the failure is loud.
 * See docs/decisions.md.
 */

beforeEach(() => {
    resetTestDb();
});

describe('the persisted full-clear flag', () => {
    it('records a run started from the beginning as a full clear', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], startedFromBeginning: true });

        expect(readPgcrRow('1')?.activity_was_started_from_beginning).toBe(1);
    });

    it('records a checkpoint run as not a full clear', () => {
        // The case the deleted ProcessedPGCR.isFullClear got wrong. If the
        // writer ever adopts a derivation like it, this flips to 1 and the run
        // starts appearing on full-clear leaderboards.
        seedRun({ instanceId: '1', completedBy: ['p1'], startedFromBeginning: false });

        expect(readPgcrRow('1')?.activity_was_started_from_beginning).toBe(0);
    });

    it('stores a zero starting phase index regardless of the run type', () => {
        // Bungie reports startingPhaseIndex as 0 for every run and the writer coerces
        // it with `|| 0` anyway, so the column is 0 for every row in production. Pinned so nobody
        // writes a query that assumes this column still discriminates anything.
        seedRun({ instanceId: '1', completedBy: ['p1'], startedFromBeginning: true });
        seedRun({ instanceId: '2', completedBy: ['p1'], startedFromBeginning: false });

        expect(readPgcrRow('1')?.starting_phase_index).toBe(0);
        expect(readPgcrRow('2')?.starting_phase_index).toBe(0);
    });

    it('keeps the full-clear flag independent of whether anyone finished', () => {
        // Two orthogonal facts: how the run was entered, and whether it was
        // cleared. The leaderboards require both, so conflating them would either
        // admit checkpoint clears or exclude legitimate ones.
        seedRun({ instanceId: '1', incompleteBy: ['p1'], startedFromBeginning: true });

        const row = readPgcrRow('1');
        expect(row?.activity_was_started_from_beginning).toBe(1);
        expect(row?.completed).toBe(0);
    });
});
