import { describe, expect, it } from 'vitest';
import { processPGCR } from './pgcr';
import {
    NON_RAID_HASH,
    RAID_HASH,
    buildEntry,
    buildFireteam,
    buildPGCR,
} from '../../../tests/helpers/pgcr-builder';

/**
 * `processPGCR` is pure — JSON in, object out — so it needs no setup and is the
 * right first target. It is the funnel every ingested raid passes through.
 *
 * NOT COVERED HERE, DELIBERATELY: `ProcessedPGCR.isFullClear`. That field is
 * computed and returned but never read by anything — `fetchAndStorePGCR`
 * persists Bungie's raw `activityWasStartedFromBeginning` instead, and every
 * leaderboard filters on that column. The derivation is also wrong: Bungie now
 * reports `startingPhaseIndex: 0` on every PGCR — including checkpoint runs, as
 * the captured fixtures show — so the `=== 0` branch fires unconditionally and
 * reports every run as a full clear. It is dead code slated for removal, so pinning its behaviour here would
 * only make that removal harder. The signal that actually decides leaderboard
 * membership is covered in tests/db/full-clear-flag.test.ts.
 * See docs/decisions.md.
 */

describe('run completion', () => {
    it('counts the run as completed when a single member finished', () => {
        // `completed` is per-entry and the check is an .some(): five people can
        // leave and the run still counts, which is correct — the raid was cleared.
        const pgcr = buildPGCR({ entries: buildFireteam({ size: 6, completions: 1 }) });

        expect(processPGCR(pgcr).completed).toBe(true);
    });

    it('counts the run as not completed when nobody finished', () => {
        // 55% of stored PGCRs land here, so this is the common path, not the edge.
        const pgcr = buildPGCR({ entries: buildFireteam({ size: 6, completions: 0 }) });

        expect(processPGCR(pgcr).completed).toBe(false);
    });

    it('counts the run as not completed when it has no entries at all', () => {
        expect(processPGCR(buildPGCR({ entries: [] })).completed).toBe(false);
    });

    it('treats a missing completion stat as not completed', () => {
        // Old PGCRs omit stats rather than reporting zero.
        const entry = buildEntry();
        delete entry.values.completed;

        expect(processPGCR(buildPGCR({ entries: [entry] })).completed).toBe(false);
    });
});

describe('activity identification', () => {
    it('prefers the director activity hash', () => {
        const pgcr = buildPGCR({ activityHash: RAID_HASH, referenceId: NON_RAID_HASH });

        expect(processPGCR(pgcr).activityHash).toBe(RAID_HASH);
    });

    it('falls back to the reference id when the director hash is absent', () => {
        // Bungie reports directorActivityHash as 0 for some older activities, and
        // `||` treats that as absent — which is the intended behaviour here.
        const pgcr = buildPGCR({ activityHash: 0, referenceId: RAID_HASH });

        expect(processPGCR(pgcr).activityHash).toBe(RAID_HASH);
    });

    it('resolves a known raid to its key', () => {
        const pgcr = buildPGCR({ activityHash: RAID_HASH });

        expect(processPGCR(pgcr).raidKey).toBe('salvations_edge');
    });

    it('leaves the raid key unset for an activity that is not a raid', () => {
        // The crawler drops non-raids on this basis, so a wrong answer here either
        // floods the database with strikes or silently discards real raids.
        const pgcr = buildPGCR({ activityHash: NON_RAID_HASH });

        expect(processPGCR(pgcr).raidKey).toBeUndefined();
    });

    it('carries the instance id through unchanged', () => {
        // Instance ids exceed 2^31 and are handled as strings throughout; any
        // numeric coercion would corrupt them.
        const pgcr = buildPGCR({ instanceId: '17091392013' });

        expect(processPGCR(pgcr).instanceId).toBe('17091392013');
    });
});

describe('period conversion', () => {
    it('converts Bungie\'s ISO timestamp to unix seconds', () => {
        const pgcr = buildPGCR({ period: '2026-07-26T12:00:00Z' });

        expect(processPGCR(pgcr).period).toBe(Math.floor(Date.UTC(2026, 6, 26, 12, 0, 0) / 1000));
    });

    it('is unaffected by a daylight-saving boundary', () => {
        // Bungie reports UTC, which has no DST. This pins that the conversion does
        // not pick up the host's local offset — a machine in a DST-observing zone
        // would otherwise shift every run by an hour twice a year, quietly moving
        // runs across leaderboard cutoffs.
        const pgcr = buildPGCR({ period: '2026-03-29T01:30:00Z' });

        expect(processPGCR(pgcr).period).toBe(Math.floor(Date.UTC(2026, 2, 29, 1, 30, 0) / 1000));
    });

    it('truncates sub-second precision rather than rounding up', () => {
        const pgcr = buildPGCR({ period: '2026-07-26T12:00:00.999Z' });

        expect(processPGCR(pgcr).period).toBe(Math.floor(Date.UTC(2026, 6, 26, 12, 0, 0) / 1000));
    });
});

describe('difficulty tier extraction', () => {
    it('carries through -1 (implicitly Normal)', () => {
        const pgcr = buildPGCR({ activityDifficultyTier: -1 });

        expect(processPGCR(pgcr).difficultyTier).toBe(-1);
    });

    it('carries through 0 (explicitly Normal)', () => {
        const pgcr = buildPGCR({ activityDifficultyTier: 0 });

        expect(processPGCR(pgcr).difficultyTier).toBe(0);
    });

    it('carries through a higher tier value (Master)', () => {
        const pgcr = buildPGCR({ activityDifficultyTier: 9 });

        expect(processPGCR(pgcr).difficultyTier).toBe(9);
    });

    it('is undefined when the field is absent', () => {
        const pgcr = buildPGCR();

        expect(processPGCR(pgcr).difficultyTier).toBeUndefined();
    });
});

describe('unique player count', () => {
    it('counts distinct membership IDs, not entries', () => {
        // Two players, three entries: player 1 has two characters (same membershipId).
        const entries = [
            buildEntry({ membershipId: 'player-1', displayName: 'P1-Warlock' }),
            buildEntry({ membershipId: 'player-1', displayName: 'P1-Hunter' }),
            buildEntry({ membershipId: 'player-2', displayName: 'P2' }),
        ];

        expect(processPGCR(buildPGCR({ entries })).uniquePlayerCount).toBe(2);
    });

    it('equals entry count when every entry is a different player', () => {
        const entries = buildFireteam({ size: 6 });

        expect(processPGCR(buildPGCR({ entries })).uniquePlayerCount).toBe(6);
    });

    it('is zero for an empty PGCR', () => {
        expect(processPGCR(buildPGCR({ entries: [] })).uniquePlayerCount).toBe(0);
    });

    it('handles a solo player correctly', () => {
        const entries = [buildEntry({ membershipId: 'solo-player' })];

        expect(processPGCR(buildPGCR({ entries })).uniquePlayerCount).toBe(1);
    });
});

describe('player extraction', () => {
    it('keeps one record per entry', () => {
        const pgcr = buildPGCR({ entries: buildFireteam({ size: 6 }) });

        expect(processPGCR(pgcr).players).toHaveLength(6);
    });

    it('preserves the parts that make up a Name#Code identity', () => {
        // Player identity is Name#Code throughout the system; dropping either half
        // here produces the partial-name bug the project has hit before.
        const entry = buildEntry({
            membershipId: '4611686018400000001',
            bungieGlobalDisplayName: 'Guardian',
            bungieGlobalDisplayNameCode: 42,
        });

        const [player] = processPGCR(buildPGCR({ entries: [entry] })).players;

        expect(player.bungieGlobalDisplayName).toBe('Guardian');
        expect(player.bungieGlobalDisplayNameCode).toBe(42);
    });

    it('tolerates an entry with no global display name', () => {
        // Bungie withholds it for some accounts. Extraction must not throw; the
        // downstream display path falls back to the platform display name.
        const entry = buildEntry({
            displayName: 'LegacyName',
            bungieGlobalDisplayName: null,
            bungieGlobalDisplayNameCode: null,
        });

        const [player] = processPGCR(buildPGCR({ entries: [entry] })).players;

        expect(player.bungieGlobalDisplayName).toBeUndefined();
        expect(player.displayName).toBe('LegacyName');
    });

    it('retains every member of an oversized fireteam', () => {
        // Entry counts above six are normal: players joining and leaving each get
        // an entry, and the database has raids with seven or more.
        const pgcr = buildPGCR({ entries: buildFireteam({ size: 9 }) });

        expect(processPGCR(pgcr).players).toHaveLength(9);
    });
});
