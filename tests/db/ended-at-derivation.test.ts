import { beforeEach, describe, expect, it } from 'vitest';
import { FUTURE_ENDED_SKEW_SECONDS, computeActivityDurationSeconds } from '@/lib/db/queries';
import { getDb } from '@/lib/db';
import { resetTestDb } from '../helpers/db';
import { hoursAgo, readPgcrRow, seedPlayer, seedRun } from '../helpers/seed';

/**
 * `pgcrs.ended_at` is the denormalized run end time (period + duration) that
 * replaced the old `run_durations` CTE in the phase 3b reader cutover (610408e).
 * Every leaderboard, the recent-completions list, and the completion-time stats
 * now filter and sort on it, so a wrong derivation does not crash anything — it
 * silently returns the wrong set of runs. That is the failure mode this file
 * exists to catch.
 */

beforeEach(() => {
    resetTestDb();
});

describe('computeActivityDurationSeconds', () => {
    it('prefers Bungie\'s activity-level duration over per-player time', () => {
        const players = [{ startSeconds: 0, timePlayedSeconds: 900 }];

        expect(computeActivityDurationSeconds(2400, players)).toBe(2400);
    });

    it('falls back to per-player time when the activity duration is absent', () => {
        const players = [
            { startSeconds: 0, timePlayedSeconds: 900 },
            { startSeconds: 0, timePlayedSeconds: 1500 },
        ];

        expect(computeActivityDurationSeconds(null, players)).toBe(1500);
    });

    it('treats a zero activity duration as unusable rather than as a real value', () => {
        // `> 0` not `!= null`: a zero duration is Bungie reporting nothing useful,
        // and accepting it would pin ended_at to the run's start time.
        const players = [{ startSeconds: 0, timePlayedSeconds: 1500 }];

        expect(computeActivityDurationSeconds(0, players)).toBe(1500);
    });

    it('counts a late joiner\'s offset so the run is not measured from their arrival', () => {
        // The player who joined 1200s in and played 600s establishes a 1800s run,
        // even though nobody's individual time exceeds 900s.
        const players = [
            { startSeconds: 0, timePlayedSeconds: 900 },
            { startSeconds: 1200, timePlayedSeconds: 600 },
        ];

        expect(computeActivityDurationSeconds(null, players)).toBe(1800);
    });

    it('considers players who did not complete, not just those who did', () => {
        // The pre-cutover CTE filtered on completed = 1. This deliberately does not:
        // someone who left before the end still bounds how long the activity ran.
        const players = [
            { startSeconds: 0, timePlayedSeconds: 2400 },
            { startSeconds: 0, timePlayedSeconds: 600 },
        ];

        expect(computeActivityDurationSeconds(null, players)).toBe(2400);
    });

    it('collapses to the longest time played when no start offsets are reported', () => {
        const players = [
            { startSeconds: null, timePlayedSeconds: 900 },
            { timePlayedSeconds: 1500 },
        ];

        expect(computeActivityDurationSeconds(null, players)).toBe(1500);
    });

    it('reports no duration at all for an empty PGCR', () => {
        expect(computeActivityDurationSeconds(null, [])).toBeNull();
    });

    it('reports no duration when every player has zero time played', () => {
        const players = [
            { startSeconds: 0, timePlayedSeconds: 0 },
            { startSeconds: 0, timePlayedSeconds: 0 },
        ];

        expect(computeActivityDurationSeconds(null, players)).toBeNull();
    });
});

describe('ended_at as persisted by insertFullPGCR', () => {
    it('stores the run end as start plus duration', () => {
        const period = hoursAgo(3);
        seedRun({ instanceId: '1', period, completedBy: ['p1'], activityDurationSeconds: 1800 });

        expect(readPgcrRow('1')?.ended_at).toBe(period + 1800);
    });

    it('leaves the end time unknown when no duration can be derived', () => {
        // Tier 3. A NULL ended_at drops the run from every leaderboard, because
        // they all filter `ended_at >= cutoff`. That exclusion is intended: a run
        // with no derivable end time cannot be placed in a time window.
        seedRun({
            instanceId: '1',
            completedBy: ['p1'],
            activityDurationSeconds: null,
            timePlayedSeconds: 0,
        });

        expect(readPgcrRow('1')?.ended_at).toBeNull();
    });

    it('discards a future end time as corrupt', () => {
        // Bungie reports absurd durations for farm/checkpoint megalobby instances
        // — multi-day "activities". A PGCR is only ingested after the run ended,
        // so an end time beyond now is malformed by definition.
        seedRun({
            instanceId: '1',
            period: hoursAgo(1),
            completedBy: ['p1'],
            activityDurationSeconds: 30 * 24 * 3600,
        });

        expect(readPgcrRow('1')?.ended_at).toBeNull();
    });

    it('keeps a just-finished run whose end time is barely ahead of the ingest clock', () => {
        // Clock skew between Bungie and the crawler must not be mistaken for
        // corruption, so the guard allows an hour of headroom.
        const period = Math.floor(Date.now() / 1000);
        const duration = FUTURE_ENDED_SKEW_SECONDS - 60;
        seedRun({ instanceId: '1', period, completedBy: ['p1'], activityDurationSeconds: duration });

        expect(readPgcrRow('1')?.ended_at).toBe(period + duration);
    });
});

describe('players.last_seen_at maintenance', () => {
    it('advances to the end time of a newly ingested run', () => {
        const period = hoursAgo(2);
        seedPlayer('p1');
        seedRun({ instanceId: '1', period, completedBy: ['p1'], activityDurationSeconds: 1800 });

        expect(readLastSeen('p1')).toBe(period + 1800);
    });

    it('never moves backwards when an older run is ingested late', () => {
        // The scanner backfills runs out of order, so an old PGCR routinely arrives
        // after a newer one. Moving last_seen_at backwards would demote an active
        // player into the cold crawl bucket.
        const recent = hoursAgo(1);
        seedPlayer('p1');
        seedRun({ instanceId: '1', period: recent, completedBy: ['p1'], activityDurationSeconds: 1800 });
        seedRun({ instanceId: '2', period: hoursAgo(50), completedBy: ['p1'], activityDurationSeconds: 1800 });

        expect(readLastSeen('p1')).toBe(recent + 1800);
    });

    it('is untouched by a run with no derivable end time', () => {
        seedPlayer('p1');
        seedRun({
            instanceId: '1',
            completedBy: ['p1'],
            activityDurationSeconds: null,
            timePlayedSeconds: 0,
        });

        expect(readLastSeen('p1')).toBeFalsy();
    });

    it('advances for a player who did not complete the run', () => {
        // last_seen_at tracks presence, not achievement — someone who joined and
        // left was still online, and the crawl buckets care about that.
        const period = hoursAgo(2);
        seedPlayer('p2');
        seedRun({
            instanceId: '1',
            period,
            completedBy: ['p1'],
            incompleteBy: ['p2'],
            activityDurationSeconds: 1800,
        });

        expect(readLastSeen('p2')).toBe(period + 1800);
    });
});

function readLastSeen(membershipId: string): number | null {
    const row = getDb()
        .prepare('SELECT last_seen_at FROM players WHERE membership_id = ?')
        .get(membershipId) as { last_seen_at: number | null } | undefined;
    return row?.last_seen_at ?? null;
}
