import { beforeEach, describe, expect, it } from 'vitest';
import { runLeaderboardRows } from '@/lib/cache/leaderboard-cache';
import { resetTestDb } from '../helpers/db';
import { seedPlayer, seedRun } from '../helpers/seed';

/**
 * The leaderboard is the product. A crash here would be noticed within minutes;
 * a silently wrong row set would not be noticed at all, which is why these tests
 * assert membership and ordering rather than "it returned something".
 *
 * Raid hashes are real values from RAID_DEFINITIONS in bungie/manifest.ts.
 */
const SALVATIONS_EDGE = 2192826039;
const CROTAS_END = 1566480315;

const DURATION = 1800;
const HOURS_BACK = 24;

/** Places a run so it ends exactly `offsetSeconds` relative to the 24h cutoff.
 *  Negative lands inside the window, positive lands outside (further in the past). */
function endingRelativeToCutoff(offsetSeconds: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - HOURS_BACK * 3600;
    return cutoff - offsetSeconds - DURATION;
}

beforeEach(() => {
    resetTestDb();
});

describe('who appears on the leaderboard', () => {
    it('counts a raid instance once per player, however many entries they have', () => {
        // pgcr_players is keyed (instance_id, membership_id), so a player running
        // two characters through one instance collapses to a single row at insert
        // and COUNT(DISTINCT instance_id) keeps it that way if that ever changes.
        seedRun({ instanceId: '1', completedBy: ['p1'] });
        seedRun({ instanceId: '2', completedBy: ['p1'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10);

        expect(rows).toHaveLength(1);
        expect(rows[0].completions).toBe(2);
    });

    it('excludes a checkpoint run', () => {
        // The live full-clear signal: Bungie's raw
        // activityWasStartedFromBeginning. A derived alternative once existed
        // (ProcessedPGCR.isFullClear) that reported every run as a full clear;
        // it was never persisted and has been deleted.
        // See docs/testing-framework-plan.md.
        seedRun({ instanceId: '1', completedBy: ['p1'], startedFromBeginning: false });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)).toEqual([]);
    });

    it('excludes a player who was present but did not finish', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], incompleteBy: ['p2'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10);

        expect(rows.map((r) => r.membershipId)).toEqual(['p1']);
    });

    it('excludes a run that nobody completed', () => {
        // 55% of stored PGCRs have zero completions, so this is the single most
        // common shape in the table rather than an edge case.
        seedRun({ instanceId: '1', incompleteBy: ['p1', 'p2'] });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)).toEqual([]);
    });

    it('excludes a run with no derivable end time', () => {
        // ended_at IS NULL fails `ended_at >= cutoff`, so the run cannot be placed
        // in any time window and drops out entirely.
        seedRun({
            instanceId: '1',
            completedBy: ['p1'],
            activityDurationSeconds: null,
            timePlayedSeconds: 0,
        });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)).toEqual([]);
    });
});

describe('the time window', () => {
    it('includes a run that ended just inside the cutoff', () => {
        seedRun({
            instanceId: '1',
            period: endingRelativeToCutoff(-60),
            completedBy: ['p1'],
            activityDurationSeconds: DURATION,
        });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)).toHaveLength(1);
    });

    it('excludes a run that ended just outside the cutoff', () => {
        seedRun({
            instanceId: '1',
            period: endingRelativeToCutoff(60),
            completedBy: ['p1'],
            activityDurationSeconds: DURATION,
        });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)).toEqual([]);
    });

    it('judges the window by when a run ended, not when it started', () => {
        // A long run that began before the cutoff but finished inside it counts.
        // This is precisely what the ended_at denormalization exists to express.
        const cutoff = Math.floor(Date.now() / 1000) - HOURS_BACK * 3600;
        seedRun({
            instanceId: '1',
            period: cutoff - 600,
            completedBy: ['p1'],
            activityDurationSeconds: 1200,
        });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)).toHaveLength(1);
    });
});

describe('raid filtering', () => {
    it('counts only the requested raid', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], activityHash: SALVATIONS_EDGE });
        seedRun({ instanceId: '2', completedBy: ['p1'], activityHash: CROTAS_END });

        const rows = runLeaderboardRows(HOURS_BACK, ['salvations_edge'], 10);

        expect(rows[0].completions).toBe(1);
    });

    it('counts every raid when no filter is given', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], activityHash: SALVATIONS_EDGE });
        seedRun({ instanceId: '2', completedBy: ['p1'], activityHash: CROTAS_END });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)[0].completions).toBe(2);
    });

    it('counts the union when several raids are requested', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], activityHash: SALVATIONS_EDGE });
        seedRun({ instanceId: '2', completedBy: ['p1'], activityHash: CROTAS_END });

        const rows = runLeaderboardRows(HOURS_BACK, ['salvations_edge', 'crotas_end'], 10);

        expect(rows[0].completions).toBe(2);
    });
});

describe('ordering and limit', () => {
    it('ranks the most completions first', () => {
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2'] });
        seedRun({ instanceId: '2', completedBy: ['p1'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10);

        expect(rows.map((r) => r.membershipId)).toEqual(['p1', 'p2']);
    });

    it('breaks a tie in favour of whoever got there first', () => {
        // lastClearAt ASC. A player who reached three clears an hour ago outranks
        // one who reached three a minute ago, so a stale PGCR discovered late still
        // slots its player at their true historical position.
        seedRun({ instanceId: '1', period: hoursBeforeNow(10), completedBy: ['early'] });
        seedRun({ instanceId: '2', period: hoursBeforeNow(1), completedBy: ['late'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10);

        expect(rows.map((r) => r.membershipId)).toEqual(['early', 'late']);
    });

    it('breaks a remaining tie by membership id so the order is never arbitrary', () => {
        const period = hoursBeforeNow(5);
        seedRun({ instanceId: '1', period, completedBy: ['bbb', 'aaa'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10);

        expect(rows.map((r) => r.membershipId)).toEqual(['aaa', 'bbb']);
    });

    it('returns at most the requested number of players', () => {
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2', 'p3'] });

        expect(runLeaderboardRows(HOURS_BACK, [], 2)).toHaveLength(2);
    });
});

describe('rank assignment', () => {
    it('gives tied players the same rank and skips the ranks they consumed', () => {
        // Competition ranking: 1, 2, 2, 4 — not 1, 2, 2, 3.
        seedRun({ instanceId: '1', period: hoursBeforeNow(5), completedBy: ['top', 'mid1', 'mid2', 'low'] });
        seedRun({ instanceId: '2', period: hoursBeforeNow(5), completedBy: ['top', 'mid1', 'mid2'] });
        seedRun({ instanceId: '3', period: hoursBeforeNow(5), completedBy: ['top'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10);

        expect(rows.map((r) => [r.membershipId, r.completions, r.rank])).toEqual([
            ['top', 3, 1],
            ['mid1', 2, 2],
            ['mid2', 2, 2],
            ['low', 1, 4],
        ]);
    });
});

describe('display names', () => {
    it('renders the full Name#Code, zero-padding the code to four digits', () => {
        seedPlayer('p1', 'Guardian', 42);
        seedRun({ instanceId: '1', completedBy: ['p1'] });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)[0].displayName).toBe('Guardian#0042');
    });

    it('falls back to the name recorded on the run when the player is not yet crawled', () => {
        // A player appears in pgcr_players the moment a run is ingested, but only
        // enters the players table once crawled — which is why the join is a LEFT
        // one and why this fallback is load-bearing rather than defensive.
        seedRun({ instanceId: '1', completedBy: ['p1'] });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)[0].displayName).toBe('Guardian-p1');
    });

    it('BUG: drops the #Code entirely when the code is zero', () => {
        // formatDisplayName guards with `&& entry.bungieGlobalDisplayNameCode`, so a
        // code of 0 is falsy and the branch is skipped, yielding a partial name.
        // CLAUDE.md calls the full Name#Code form load-bearing and notes partial
        // names were a real bug before. Pinned as current behaviour, not endorsed —
        // see docs/decisions.md.
        seedPlayer('p1', 'Guardian', 0);
        seedRun({ instanceId: '1', completedBy: ['p1'] });

        expect(runLeaderboardRows(HOURS_BACK, [], 10)[0].displayName).toBe('Guardian');
    });
});

describe('difficulty filtering', () => {
    it('master filter returns only runs with difficulty_tier > 0', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 2 });
        seedRun({ instanceId: '2', completedBy: ['p1'], difficultyTier: 0 });
        seedRun({ instanceId: '3', completedBy: ['p1'], difficultyTier: -1 });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { difficulty: 'master' });

        expect(rows).toHaveLength(1);
        expect(rows[0].completions).toBe(1);
    });

    it('normal filter includes difficulty_tier <= 0 and NULL', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 2 });
        seedRun({ instanceId: '2', completedBy: ['p1'], difficultyTier: 0 });
        seedRun({ instanceId: '3', completedBy: ['p1'], difficultyTier: -1 });
        seedRun({ instanceId: '4', completedBy: ['p1'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { difficulty: 'normal' });

        expect(rows).toHaveLength(1);
        expect(rows[0].completions).toBe(3);
    });

    it('no filter includes all regardless of difficulty_tier', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 2 });
        seedRun({ instanceId: '2', completedBy: ['p1'], difficultyTier: 0 });
        seedRun({ instanceId: '3', completedBy: ['p1'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10);

        expect(rows[0].completions).toBe(3);
    });
});

describe('exactPlayers filtering', () => {
    it('exactPlayers=1 returns only solo completions', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p1'], uniquePlayerCount: 3 });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { exactPlayers: 1 });

        expect(rows[0].completions).toBe(1);
    });

    it('exactPlayers=3 returns only trios, not solos or duos', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p1'], uniquePlayerCount: 2 });
        seedRun({ instanceId: '3', completedBy: ['p1'], uniquePlayerCount: 3 });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { exactPlayers: 3 });

        expect(rows[0].completions).toBe(1);
    });

    it('excludes rows with NULL unique_player_count', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p1'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { exactPlayers: 1 });

        expect(rows[0].completions).toBe(1);
    });
});

describe('maxPlayers filtering (lowman)', () => {
    it('maxPlayers=3 returns solos, duos, and trios', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p1'], uniquePlayerCount: 2 });
        seedRun({ instanceId: '3', completedBy: ['p1'], uniquePlayerCount: 3 });
        seedRun({ instanceId: '4', completedBy: ['p1'], uniquePlayerCount: 6 });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { maxPlayers: 3 });

        expect(rows[0].completions).toBe(3);
    });

    it('excludes rows with NULL unique_player_count', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p1'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { maxPlayers: 3 });

        expect(rows[0].completions).toBe(1);
    });

    it('no filter includes all regardless of unique_player_count', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p1'], uniquePlayerCount: 6 });
        seedRun({ instanceId: '3', completedBy: ['p1'] });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10);

        expect(rows[0].completions).toBe(3);
    });
});

describe('combined filters', () => {
    it('difficulty + exactPlayers compose correctly', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 2, uniquePlayerCount: 2 });
        seedRun({ instanceId: '2', completedBy: ['p1'], difficultyTier: 2, uniquePlayerCount: 6 });
        seedRun({ instanceId: '3', completedBy: ['p1'], difficultyTier: 0, uniquePlayerCount: 2 });
        seedRun({ instanceId: '4', completedBy: ['p1'], difficultyTier: 0, uniquePlayerCount: 6 });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { difficulty: 'master', exactPlayers: 2 });

        expect(rows[0].completions).toBe(1);
    });

    it('difficulty + maxPlayers (lowman) compose correctly', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 2, uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p1'], difficultyTier: 2, uniquePlayerCount: 3 });
        seedRun({ instanceId: '3', completedBy: ['p1'], difficultyTier: 2, uniquePlayerCount: 6 });
        seedRun({ instanceId: '4', completedBy: ['p1'], difficultyTier: 0, uniquePlayerCount: 2 });

        const rows = runLeaderboardRows(HOURS_BACK, [], 10, { difficulty: 'master', maxPlayers: 3 });

        expect(rows[0].completions).toBe(2);
    });

    it('difficulty + exactPlayers + raid filter compose correctly', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 2, uniquePlayerCount: 2, activityHash: SALVATIONS_EDGE });
        seedRun({ instanceId: '2', completedBy: ['p1'], difficultyTier: 2, uniquePlayerCount: 2, activityHash: CROTAS_END });

        const rows = runLeaderboardRows(HOURS_BACK, ['salvations_edge'], 10, { difficulty: 'master', exactPlayers: 2 });

        expect(rows[0].completions).toBe(1);
    });
});

function hoursBeforeNow(hours: number): number {
    return Math.floor(Date.now() / 1000) - Math.round(hours * 3600);
}
