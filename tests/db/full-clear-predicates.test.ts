import { describe, it, expect, beforeEach } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { seedRun } from '../helpers/seed';
import {
    getFullClearCount,
    getPlayerRaidCompletionSummary,
    getPlayerRaidPerformanceStats,
    getPlayerRaidTeammateSummary,
    getPlayerRecentCompletions,
    getRaidStats,
} from '../../src/lib/db/queries';
import { runLeaderboardRows } from '../../src/lib/cache/leaderboard-cache';

/**
 * Two predicates share the words "full clear" and are NOT the same population.
 *
 *   Full Clear (instance) p.completed = 1 AND p.activity_was_started_from_beginning = 1
 *   Completion  (player)  pp.completed = 1 AND <Full Clear>
 *
 * `pgcrs.completed` is written as "at least one player finished", not "all of
 * them" (see processPGCR), so a player can sit inside a Full Clear without
 * having a Completion of their own. On the live database that gap is ~16% of
 * Player-Runs. Every raid-stats scope counts that player; every player-facing
 * and leaderboard query must not.
 *
 * This file pins the pair. Nothing else does: raid-stats.test.ts asserts the
 * two *scopes* differ and player-stats.test.ts covers a per-player DNF, but no
 * other test seeds the one row the distinction turns on — present in an
 * instance the team cleared from the start, personally unfinished. Without it,
 * collapsing the two predicates onto one constant passes the whole suite while
 * silently moving the published full-clear KDA quartiles and class
 * distribution (ADR 0006).
 */

beforeEach(() => { resetTestDb(); });

const HOURS = 24;
const FINISHER = 'finisher';
/** In the fireteam, present for the clear, did not personally finish. */
const BYSTANDER = 'bystander';

/** One instance the fireteam cleared from the start, with one member who did not finish. */
function seedClearWithABystander(alsoFinished: string[] = []): void {
    seedRun({
        instanceId: '1',
        completedBy: [FINISHER, ...alsoFinished],
        incompleteBy: [BYSTANDER],
        startedFromBeginning: true,
    });
}

describe('a player inside a full clear who did not personally finish', () => {
    it('is counted by the instance-level Full Clear predicate', () => {
        seedClearWithABystander();

        const row = getRaidStats(HOURS)[0];

        // Both Player-Runs, the bystander's included: the fullClear scope's
        // population is instance-level and has no per-player conjunct.
        expect(row.fullClear.sampleSize).toBe(2);
        // And the instance itself is one full clear, counted once.
        expect(getFullClearCount(HOURS)).toBe(1);
    });

    it('is absent from the player-page completion queries', () => {
        seedClearWithABystander();

        expect(getPlayerRaidCompletionSummary(BYSTANDER, HOURS)).toEqual([]);
        expect(getPlayerRecentCompletions(BYSTANDER, HOURS)).toEqual([]);
        // The performance query counts completions with the same predicate in a
        // CASE, then drops the row on HAVING completions > 0 — so the attempt
        // does not surface at all, rather than surfacing with a zero.
        expect(getPlayerRaidPerformanceStats(BYSTANDER, HOURS)).toEqual([]);
        // Teammates hang off the player's own Completions, so there are none.
        expect(getPlayerRaidTeammateSummary(BYSTANDER, HOURS)).toEqual([]);
    });

    it('is absent from the leaderboard', () => {
        seedClearWithABystander();

        const rows = runLeaderboardRows(HOURS, [], 10);

        expect(rows.map((r) => r.membershipId)).toEqual([FINISHER]);
        expect(rows[0].completions).toBe(1);
    });

    it('does not stop the finisher from counting everywhere', () => {
        seedClearWithABystander(['mate2']);

        // The other side of the pair: the same instance is a Completion for the
        // player who did finish, so a fix that over-tightens is caught too.
        expect(getPlayerRaidCompletionSummary(FINISHER, HOURS)).toHaveLength(1);
        expect(getPlayerRecentCompletions(FINISHER, HOURS)).toHaveLength(1);
        expect(getPlayerRaidPerformanceStats(FINISHER, HOURS)[0].completions).toBe(1);
        // The teammate query applies the distinction twice: the Completion
        // predicate in its CTE picks the finisher's own runs, and a separate
        // `mate.completed = 1` keeps the bystander out of the teammate list.
        expect(getPlayerRaidTeammateSummary(FINISHER, HOURS).map((t) => t.teammateMembershipId))
            .toEqual(['mate2']);
    });
});

describe('a checkpoint run everyone finished', () => {
    it('is excluded by both predicates', () => {
        // The other conjunct, so the pair is pinned on both axes: neither the
        // instance-level nor the player-level predicate admits a checkpoint run.
        seedRun({ instanceId: '1', completedBy: [FINISHER], startedFromBeginning: false });

        expect(getRaidStats(HOURS)[0].fullClear.sampleSize).toBe(0);
        expect(getFullClearCount(HOURS)).toBe(0);
        expect(getPlayerRaidCompletionSummary(FINISHER, HOURS)).toEqual([]);
        expect(runLeaderboardRows(HOURS, [], 10)).toEqual([]);
    });
});
