import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { readPgcrRow, seedRun } from '../helpers/seed';

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
