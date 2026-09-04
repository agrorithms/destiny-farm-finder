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
 * The FULL_CLEAR / COMPLETION pair from queries.ts, pinned across every query
 * that uses either. What they mean is defined once in CONTEXT.md (`Full Clear`,
 * `Completion`) and in the constants' own docblocks; this file only proves the
 * two populations stay apart. On the live database the gap is ~16% of
 * Player-Runs.
 *
 * Other tests seed the row the distinction turns on — present in an instance the
 * team cleared from the start, personally unfinished (leaderboard.test.ts,
 * raid-stats.test.ts) — but each checks one query. Nothing before this file
 * asserted the pair holds *together*, so collapsing the two constants onto one
 * could pass those tests while silently moving the published full-clear KDA
 * quartiles and class distribution (ADR 0006).
 */

beforeEach(() => { resetTestDb(); });

const HOURS = 24;
const FINISHER = 'finisher';
/** In the fireteam, present for the clear, did not personally finish. */
const BYSTANDER = 'bystander';

describe('a player inside a full clear who did not personally finish', () => {
    it('is counted by the instance-level Full Clear predicate', () => {
        seedRun({ instanceId: '1', completedBy: [FINISHER], incompleteBy: [BYSTANDER] });

        const row = getRaidStats(HOURS)[0];

        // Both Player-Runs, the bystander's included: the fullClear scope's
        // population is instance-level and has no per-player conjunct.
        expect(row.fullClear.sampleSize).toBe(2);
        // And the instance itself is one full clear, counted once.
        expect(getFullClearCount(HOURS)).toBe(1);
    });

    it('is absent from the player-page completion queries', () => {
        seedRun({ instanceId: '1', completedBy: [FINISHER], incompleteBy: [BYSTANDER] });

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
        seedRun({ instanceId: '1', completedBy: [FINISHER], incompleteBy: [BYSTANDER] });

        const rows = runLeaderboardRows(HOURS, [], 10);

        expect(rows.map((r) => r.membershipId)).toEqual([FINISHER]);
        expect(rows[0].completions).toBe(1);
    });

    it('does not stop the finisher from counting everywhere', () => {
        seedRun({ instanceId: '1', completedBy: [FINISHER, 'mate2'], incompleteBy: [BYSTANDER] });

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
