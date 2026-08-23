import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetTestDb } from '../helpers/db';

/**
 * Verifies that `recordSessionSnapshot` persists a snapshot row with the
 * correct total counts and per-raid JSON breakdown. These rows power the
 * session history endpoint (#39).
 */

import { recordSessionSnapshot } from '@/lib/db/queries';

beforeEach(() => {
    resetTestDb();
});

function readSnapshots(): Record<string, unknown>[] {
    return testDb()
        .prepare('SELECT * FROM session_snapshots ORDER BY id')
        .all() as Record<string, unknown>[];
}

describe('recordSessionSnapshot', () => {
    it('inserts a row with correct totals and breakdown', () => {
        recordSessionSnapshot({
            totalFireteams: 5,
            totalPlayers: 22,
            raidBreakdown: {
                salvations_edge: { fireteams: 3, players: 14 },
                crotas_end: { fireteams: 2, players: 8 },
            },
        });

        const rows = readSnapshots();
        expect(rows).toHaveLength(1);
        expect(rows[0].total_fireteams).toBe(5);
        expect(rows[0].total_players).toBe(22);

        const json = JSON.parse(rows[0].raid_breakdown_json as string);
        expect(json.salvations_edge).toEqual({ fireteams: 3, players: 14 });
        expect(json.crotas_end).toEqual({ fireteams: 2, players: 8 });
    });

    it('sets the timestamp to approximately now', () => {
        const before = Math.floor(Date.now() / 1000);
        recordSessionSnapshot({
            totalFireteams: 0,
            totalPlayers: 0,
            raidBreakdown: {},
        });
        const after = Math.floor(Date.now() / 1000);

        const rows = readSnapshots();
        const ts = rows[0].timestamp as number;
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
    });

    it('accumulates multiple snapshots', () => {
        recordSessionSnapshot({
            totalFireteams: 3,
            totalPlayers: 12,
            raidBreakdown: { salvations_edge: { fireteams: 3, players: 12 } },
        });
        recordSessionSnapshot({
            totalFireteams: 5,
            totalPlayers: 20,
            raidBreakdown: { salvations_edge: { fireteams: 5, players: 20 } },
        });

        const rows = readSnapshots();
        expect(rows).toHaveLength(2);
        expect(rows[0].total_fireteams).toBe(3);
        expect(rows[1].total_fireteams).toBe(5);
    });

    it('handles an empty raid breakdown', () => {
        recordSessionSnapshot({
            totalFireteams: 0,
            totalPlayers: 0,
            raidBreakdown: {},
        });

        const rows = readSnapshots();
        expect(rows[0].total_fireteams).toBe(0);
        expect(rows[0].total_players).toBe(0);
        expect(JSON.parse(rows[0].raid_breakdown_json as string)).toEqual({});
    });
});
