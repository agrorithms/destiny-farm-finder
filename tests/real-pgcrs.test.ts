import { beforeEach, describe, expect, it } from 'vitest';
import { processPGCR } from '@/lib/crawler/pgcr';
import { computeActivityDurationSeconds } from '@/lib/db/queries';
import { isRaidActivityHash } from '@/lib/bungie/manifest';
import { readActivityDurationSeconds, readEntryStartSeconds } from '@/lib/bungie/pgcr-stats';
import type { DestinyPostGameCarnageReportData } from '@/lib/bungie/types';
import { resetTestDb, testDb } from './helpers/db';
import { seedFromFixture } from './helpers/seed';

import absurdDuration from './fixtures/pgcr-absurd-duration-crotas-end.json';
import checkpoint from './fixtures/pgcr-checkpoint-root-of-nightmares.json';
import fullClear from './fixtures/pgcr-fullclear-salvations-edge.json';
import missingNames from './fixtures/pgcr-missing-bungie-name.json';
import multiCharacter from './fixtures/pgcr-multi-character-garden.json';
import nonRaid from './fixtures/pgcr-non-raid.json';
import partialCompletion from './fixtures/pgcr-partial-completion-last-wish.json';
import zeroCompletions from './fixtures/pgcr-zero-completions-vault-of-glass.json';

/**
 * Tests against real captured Bungie responses.
 *
 * The builder-based tests cover permutations we construct. These cover the
 * shapes Bungie actually sends, which repeatedly turn out to be stranger than
 * anything we would think to build: nineteen entries in one report, six entries
 * belonging to two people, a seven-hour "duration" on an eighteen-minute raid.
 *
 * See tests/fixtures/README.md for what each file is and how it was captured.
 */

const as = (fixture: unknown) => fixture as DestinyPostGameCarnageReportData;

beforeEach(() => {
    resetTestDb();
});

describe('a clean full clear', () => {
    it('is recognised as a completed raid', () => {
        const result = processPGCR(as(fullClear));

        expect(result.raidKey).toBe('salvations_edge');
        expect(result.completed).toBe(true);
        expect(result.players).toHaveLength(6);
    });
});

describe('a checkpoint run', () => {
    it('is reported by Bungie as not started from the beginning', () => {
        expect(as(checkpoint).activityWasStartedFromBeginning).toBe(false);
    });

    it('still carries a zero starting phase index', () => {
        // The captured proof that startingPhaseIndex no longer discriminates
        // anything: Bungie sends 0 even here, on a confirmed checkpoint run. This
        // is why ProcessedPGCR.isFullClear reports true for every run — its
        // `startingPhaseIndex === 0` branch always fires. See docs/decisions.md.
        expect(as(checkpoint).startingPhaseIndex).toBe(0);
    });

    it('is excluded from the leaderboard once ingested', () => {
        seedFromFixture(as(checkpoint));

        const row = testDb()
            .prepare('SELECT activity_was_started_from_beginning AS f FROM pgcrs WHERE instance_id = ?')
            .get(as(checkpoint).activityDetails.instanceId) as { f: number };

        expect(row.f).toBe(0);
    });
});

describe('every captured raid agrees on the phase index', () => {
    it('reports 0 regardless of how the run was entered', () => {
        // Four full clears and three checkpoint runs, all reporting 0. A field that
        // takes one value across every observed case cannot be used to tell them
        // apart, whatever the type definition implies.
        const all = [fullClear, checkpoint, zeroCompletions, partialCompletion, multiCharacter, absurdDuration, missingNames];

        expect(all.map((f) => as(f).startingPhaseIndex)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });
});

describe('a run nobody completed', () => {
    it('is not counted as completed', () => {
        expect(processPGCR(as(zeroCompletions)).completed).toBe(false);
    });
});

describe('a run where one of two players finished', () => {
    it('counts as completed, because any completion counts', () => {
        expect(processPGCR(as(partialCompletion)).completed).toBe(true);
    });
});

describe('a player who brought several characters', () => {
    it('appears once per character in Bungie\'s entries', () => {
        const entries = as(multiCharacter).entries;
        const distinct = new Set(entries.map((e) => e.player.destinyUserInfo.membershipId));

        expect(entries).toHaveLength(6);
        expect(distinct.size).toBe(2);
    });

    it('collapses to one stored row per player', () => {
        // pgcr_players is keyed (instance_id, membership_id) and inserts use
        // INSERT OR IGNORE, so the second and third characters are dropped. The
        // leaderboard's COUNT(DISTINCT instance_id) would handle duplicates anyway,
        // but they never reach it.
        seedFromFixture(as(multiCharacter));

        const row = testDb()
            .prepare('SELECT COUNT(*) AS c FROM pgcr_players WHERE instance_id = ?')
            .get(as(multiCharacter).activityDetails.instanceId) as { c: number };

        expect(row.c).toBe(2);
    });

    it('keeps only the first character\'s stats, not the largest or the sum', () => {
        // Documented, not endorsed. The first entry for this player reports 981s
        // played; their longest character reports 1494s. Nothing reads these
        // columns today, so this is latent rather than user-visible.
        seedFromFixture(as(multiCharacter));

        const row = testDb()
            .prepare(
                'SELECT time_played_seconds AS t FROM pgcr_players WHERE instance_id = ? AND membership_id = ?'
            )
            .get(as(multiCharacter).activityDetails.instanceId, '4611686018462874397') as { t: number };

        expect(row.t).toBe(981);
    });

    it('still measures the activity across all characters', () => {
        // Duration is computed from the in-memory entries, before the dedupe, so
        // the dropped rows do not shorten the run.
        const entries = as(multiCharacter).entries;
        const players = entries.map((e) => ({
            startSeconds: readEntryStartSeconds(e),
            timePlayedSeconds: e.values.timePlayedSeconds?.basic?.value ?? 0,
        }));

        expect(computeActivityDurationSeconds(null, players)).toBe(2037);
    });
});

describe('a run with an absurd reported duration', () => {
    it('is taken at face value by the duration tiers', () => {
        // Tier 1 trusts Bungie: 27384s (7.6 hours) for a raid where nobody played
        // past 1093s. The tiers deliberately do not sanity-check this — the
        // future-end-time guard in insertFullPGCR is what catches it, and only
        // when the resulting end time lands ahead of the ingest clock.
        const entries = as(absurdDuration).entries;
        const players = entries.map((e) => ({
            startSeconds: readEntryStartSeconds(e),
            timePlayedSeconds: e.values.timePlayedSeconds?.basic?.value ?? 0,
        }));

        expect(readActivityDurationSeconds(entries)).toBe(27384);
        expect(computeActivityDurationSeconds(27384, players)).toBe(27384);
    });

    it('would derive a far shorter run from per-player time alone', () => {
        const entries = as(absurdDuration).entries;
        const players = entries.map((e) => ({
            startSeconds: readEntryStartSeconds(e),
            timePlayedSeconds: e.values.timePlayedSeconds?.basic?.value ?? 0,
        }));

        expect(computeActivityDurationSeconds(null, players)).toBe(1093);
    });
});

describe('a report where Bungie withholds every player identity', () => {
    it('extracts all nineteen entries without throwing', () => {
        // Nineteen entries in one raid report. Neither the count nor the total
        // absence of names is something a hand-written fixture would have said.
        const result = processPGCR(as(missingNames));

        expect(result.players).toHaveLength(19);
        expect(result.players.every((p) => p.bungieGlobalDisplayName === undefined)).toBe(true);
    });

    it('has no platform display name to fall back to either', () => {
        // Worth stating plainly: this is not "the global name is missing so use the
        // platform one". Every entry arrives as isPublic: false with membershipType
        // 0 and no name field of any kind, so there is no fallback left. The
        // downstream display path ends up rendering a raw membership id.
        const userInfo = as(missingNames).entries.map((e) => e.player.destinyUserInfo);

        expect(userInfo.every((u) => u.displayName === undefined)).toBe(true);
        expect(userInfo.every((u) => u.isPublic === false)).toBe(true);
        expect(processPGCR(as(missingNames)).players.every((p) => p.displayName === undefined)).toBe(true);
    });

    it('stores all nineteen rows with null names rather than rejecting them', () => {
        // The run is still real and still counts, so dropping it would lose a
        // genuine raid. NULL names are the correct outcome here.
        seedFromFixture(as(missingNames));

        const rows = testDb()
            .prepare(
                'SELECT COUNT(*) AS c, COUNT(display_name) AS named FROM pgcr_players WHERE instance_id = ?'
            )
            .get(as(missingNames).activityDetails.instanceId) as { c: number; named: number };

        expect(rows.c).toBe(19);
        expect(rows.named).toBe(0);
    });

    it('records membershipType 0, which is not a real platform', () => {
        // Type "None". These ids cannot be resolved against a platform without a
        // LinkedProfiles lookup, which is what scripts/cleanup exists to repair.
        seedFromFixture(as(missingNames));

        const row = testDb()
            .prepare('SELECT DISTINCT membership_type AS t FROM pgcr_players WHERE instance_id = ?')
            .get(as(missingNames).activityDetails.instanceId) as { t: number };

        expect(row.t).toBe(0);
    });
});

describe('a non-raid activity', () => {
    it('is rejected by raid detection', () => {
        const hash =
            as(nonRaid).activityDetails.directorActivityHash || as(nonRaid).activityDetails.referenceId;

        expect(isRaidActivityHash(hash)).toBe(false);
    });

    it('resolves to no raid key', () => {
        expect(processPGCR(as(nonRaid)).raidKey).toBeUndefined();
    });
});
