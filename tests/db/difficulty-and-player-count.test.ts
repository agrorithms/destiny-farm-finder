import { beforeEach, describe, expect, it } from 'vitest';
import type { DestinyPostGameCarnageReportData } from '@/lib/bungie/types';
import { resetTestDb } from '../helpers/db';
import { readPgcrRow, seedFromFixture, seedRun } from '../helpers/seed';

import multiCharacter from '../fixtures/pgcr-multi-character-garden.json';

const as = (fixture: unknown) => fixture as DestinyPostGameCarnageReportData;

/**
 * Verifies that `insertFullPGCR` persists the two new columns —
 * `difficulty_tier` and `unique_player_count` — and that they round-trip
 * through a raw row read. These columns power the difficulty and lowman
 * leaderboard filters (#36) and population analytics (#38).
 */

beforeEach(() => {
    resetTestDb();
});

describe('difficulty_tier persistence', () => {
    it('stores an explicit difficulty tier value', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 9 });

        const row = readPgcrRow('1');
        expect(row?.difficulty_tier).toBe(9);
    });

    it('stores -1 (implicitly Normal)', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: -1 });

        const row = readPgcrRow('1');
        expect(row?.difficulty_tier).toBe(-1);
    });

    it('stores 0 (explicitly Normal)', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 0 });

        const row = readPgcrRow('1');
        expect(row?.difficulty_tier).toBe(0);
    });

    it('stores NULL when no difficulty tier is provided', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'] });

        const row = readPgcrRow('1');
        expect(row?.difficulty_tier).toBeNull();
    });
});

describe('unique_player_count persistence', () => {
    it('stores the unique player count', () => {
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2'], uniquePlayerCount: 2 });

        const row = readPgcrRow('1');
        expect(row?.unique_player_count).toBe(2);
    });

    it('stores a solo run count', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });

        const row = readPgcrRow('1');
        expect(row?.unique_player_count).toBe(1);
    });

    it('stores NULL when no unique player count is provided', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'] });

        const row = readPgcrRow('1');
        expect(row?.unique_player_count).toBeNull();
    });
});

describe('real fixture: multi-character Garden of Salvation', () => {
    // The captured fixture has 6 entries from 2 unique players (one player
    // ran 3 characters, the other ran 3). processPGCR should deduplicate
    // by membershipId, and seedFromFixture should persist both new columns.

    it('computes unique_player_count as 2 despite 6 entries', () => {
        seedFromFixture(as(multiCharacter));

        const instanceId = as(multiCharacter).activityDetails.instanceId;
        const row = readPgcrRow(instanceId);
        expect(row?.unique_player_count).toBe(2);
    });

    it('persists the fixture difficulty tier (-1)', () => {
        seedFromFixture(as(multiCharacter));

        const instanceId = as(multiCharacter).activityDetails.instanceId;
        const row = readPgcrRow(instanceId);
        expect(row?.difficulty_tier).toBe(-1);
    });
});
