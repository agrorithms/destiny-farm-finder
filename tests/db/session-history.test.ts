import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetTestDb } from '../helpers/db';
import { getSessionHistory } from '@/lib/db/queries';

beforeEach(() => {
    resetTestDb();
});

function insertSnapshot(
    timestamp: number,
    totalFireteams: number,
    totalPlayers: number,
    raidBreakdown: Record<string, { fireteams: number; players: number }>
): void {
    testDb().prepare(`
        INSERT INTO session_snapshots (timestamp, total_fireteams, total_players, raid_breakdown_json)
        VALUES (?, ?, ?, ?)
    `).run(timestamp, totalFireteams, totalPlayers, JSON.stringify(raidBreakdown));
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

describe('getSessionHistory', () => {
    describe('raw mode (hours <= stepdownHours)', () => {
        it('returns raw snapshots ordered by timestamp', () => {
            const now = nowSeconds();
            insertSnapshot(now - 300, 5, 22, { salvations_edge: { fireteams: 3, players: 14 } });
            insertSnapshot(now - 180, 7, 30, { salvations_edge: { fireteams: 4, players: 18 }, crotas_end: { fireteams: 3, players: 12 } });
            insertSnapshot(now - 60, 3, 12, { crotas_end: { fireteams: 3, players: 12 } });

            const result = getSessionHistory(1, 24);

            expect(result).toHaveLength(3);
            expect(result[0].timestamp).toBe(now - 300);
            expect(result[0].totalFireteams).toBe(5);
            expect(result[0].totalPlayers).toBe(22);
            expect(result[0].raidBreakdown).toEqual({ salvations_edge: { fireteams: 3, players: 14 } });

            expect(result[1].totalFireteams).toBe(7);
            expect(result[2].totalFireteams).toBe(3);
        });

        it('excludes snapshots outside the time window', () => {
            const now = nowSeconds();
            insertSnapshot(now - 7200, 10, 50, {}); // 2 hours ago — outside 1h window
            insertSnapshot(now - 300, 5, 22, {});    // 5 min ago — inside

            const result = getSessionHistory(1, 24);

            expect(result).toHaveLength(1);
            expect(result[0].totalFireteams).toBe(5);
        });

        it('returns empty array when no snapshots exist', () => {
            const result = getSessionHistory(24, 24);
            expect(result).toEqual([]);
        });

        it('parses raidBreakdown JSON correctly', () => {
            const now = nowSeconds();
            const breakdown = {
                salvations_edge: { fireteams: 3, players: 14 },
                crotas_end: { fireteams: 2, players: 8 },
                last_wish: { fireteams: 1, players: 6 },
            };
            insertSnapshot(now - 60, 6, 28, breakdown);

            const result = getSessionHistory(1, 24);

            expect(result[0].raidBreakdown).toEqual(breakdown);
        });
    });

    describe('aggregated mode (hours > stepdownHours)', () => {
        it('averages snapshots within the same hour bucket', () => {
            const now = nowSeconds();
            const hourStart = Math.floor(now / 3600) * 3600;

            // Three snapshots within the same hour bucket
            insertSnapshot(hourStart + 60, 6, 24, {});
            insertSnapshot(hourStart + 180, 12, 48, {});
            insertSnapshot(hourStart + 300, 9, 36, {});

            // stepdownHours=0 forces aggregation even for short windows
            const result = getSessionHistory(1, 0);

            expect(result).toHaveLength(1);
            expect(result[0].timestamp).toBe(hourStart);
            expect(result[0].totalFireteams).toBe(9);   // round((6+12+9)/3) = 9
            expect(result[0].totalPlayers).toBe(36);     // round((24+48+36)/3) = 36
        });

        it('separates snapshots into different hour buckets', () => {
            const now = nowSeconds();
            const currentHour = Math.floor(now / 3600) * 3600;
            const prevHour = currentHour - 3600;

            insertSnapshot(prevHour + 60, 4, 16, {});
            insertSnapshot(prevHour + 180, 8, 32, {});
            insertSnapshot(currentHour + 60, 10, 40, {});

            const result = getSessionHistory(2, 0);

            expect(result).toHaveLength(2);
            expect(result[0].timestamp).toBe(prevHour);
            expect(result[0].totalFireteams).toBe(6);    // round((4+8)/2) = 6
            expect(result[0].totalPlayers).toBe(24);     // round((16+32)/2) = 24
            expect(result[1].timestamp).toBe(currentHour);
            expect(result[1].totalFireteams).toBe(10);
            expect(result[1].totalPlayers).toBe(40);
        });

        it('averages raid breakdown across snapshots in a bucket', () => {
            const now = nowSeconds();
            const hourStart = Math.floor(now / 3600) * 3600;

            insertSnapshot(hourStart + 60, 6, 24, {
                salvations_edge: { fireteams: 3, players: 12 },
                crotas_end: { fireteams: 3, players: 12 },
            });
            insertSnapshot(hourStart + 180, 12, 48, {
                salvations_edge: { fireteams: 6, players: 24 },
                crotas_end: { fireteams: 6, players: 24 },
            });

            const result = getSessionHistory(1, 0);

            expect(result).toHaveLength(1);
            // salvations_edge: round((3+6)/2)=5 fireteams, round((12+24)/2)=18 players
            expect(result[0].raidBreakdown.salvations_edge).toEqual({ fireteams: 5, players: 18 });
            // crotas_end: round((3+6)/2)=5 fireteams, round((12+24)/2)=18 players
            expect(result[0].raidBreakdown.crotas_end).toEqual({ fireteams: 5, players: 18 });
        });

        it('treats missing raids in some snapshots as zero when averaging', () => {
            const now = nowSeconds();
            const hourStart = Math.floor(now / 3600) * 3600;

            insertSnapshot(hourStart + 60, 3, 12, {
                salvations_edge: { fireteams: 3, players: 12 },
            });
            insertSnapshot(hourStart + 180, 2, 8, {
                crotas_end: { fireteams: 2, players: 8 },
            });

            const result = getSessionHistory(1, 0);

            expect(result).toHaveLength(1);
            // salvations_edge appears in 1 of 2 snapshots: round((3+0)/2)=2
            expect(result[0].raidBreakdown.salvations_edge).toEqual({ fireteams: 2, players: 6 });
            // crotas_end appears in 1 of 2 snapshots: round((0+2)/2)=1
            expect(result[0].raidBreakdown.crotas_end).toEqual({ fireteams: 1, players: 4 });
        });

        it('returns empty array when no snapshots in window', () => {
            const result = getSessionHistory(48, 0);
            expect(result).toEqual([]);
        });
    });

    describe('stepdown threshold boundary', () => {
        it('uses raw mode when hours equals stepdownHours exactly', () => {
            const now = nowSeconds();
            const hourStart = Math.floor(now / 3600) * 3600;

            // Two snapshots in the same hour
            insertSnapshot(hourStart + 60, 6, 24, {});
            insertSnapshot(hourStart + 180, 12, 48, {});

            // hours=1, stepdown=1 → raw mode (<=)
            const result = getSessionHistory(1, 1);

            expect(result).toHaveLength(2);
            expect(result[0].totalFireteams).toBe(6);
            expect(result[1].totalFireteams).toBe(12);
        });

        it('uses aggregated mode when hours exceeds stepdownHours by one', () => {
            const now = nowSeconds();
            const hourStart = Math.floor(now / 3600) * 3600;

            insertSnapshot(hourStart + 60, 6, 24, {});
            insertSnapshot(hourStart + 180, 12, 48, {});

            // hours=2, stepdown=1 → aggregated
            const result = getSessionHistory(2, 1);

            expect(result).toHaveLength(1);
            expect(result[0].totalFireteams).toBe(9); // avg
        });
    });
});
