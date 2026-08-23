import { describe, it, expect, beforeEach } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { seedRun, hoursAgo } from '../helpers/seed';
import { getRaidStats } from '../../src/lib/db/queries';

beforeEach(() => { resetTestDb(); });

const SALVATIONS_EDGE_HASH = 2192826039;

describe('getRaidStats', () => {
    it('returns per-raid fastest clear, DNF rate, class distribution, and avg KDA', () => {
        // Salvation's Edge: 2 completed, 1 DNF
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2'], activityHash: SALVATIONS_EDGE_HASH, activityDurationSeconds: 3600, kills: 80, deaths: 10, assists: 30 });
        seedRun({ instanceId: '2', completedBy: ['p3'], activityHash: SALVATIONS_EDGE_HASH, activityDurationSeconds: 1200, kills: 50, deaths: 5, assists: 20 });
        seedRun({ instanceId: '3', incompleteBy: ['p4'], activityHash: SALVATIONS_EDGE_HASH, completed: false });

        const stats = getRaidStats(24);
        const se = stats.find(s => s.raidKey === 'salvations_edge');
        expect(se).toBeDefined();
        expect(se!.fastestClearSeconds).toBe(1200);
        // 1 DNF out of 3 instances
        expect(se!.dnfRate).toBeCloseTo(1 / 3, 4);
    });

    it('computes avgKda across all players in completed instances', () => {
        // Two players complete: p1 gets (80+30)/max(10,1)=11, p2 gets (80+30)/max(10,1)=11
        // avg = 11
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2'], kills: 80, deaths: 10, assists: 30 });

        const stats = getRaidStats(24);
        expect(stats[0].avgKda).toBe(11);
    });

    it('returns class distribution as counts per class', () => {
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2', 'p3'] });

        const stats = getRaidStats(24);
        // seedRun defaults all players to Warlock
        expect(stats[0].classDistribution).toEqual({ Warlock: 3 });
    });

    it('respects the hours time window', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], period: hoursAgo(2) });
        seedRun({ instanceId: '2', completedBy: ['p2'], period: hoursAgo(10) });

        const stats = getRaidStats(4);
        // Only one instance in window, so one player total
        expect(stats[0].classDistribution).toEqual({ Warlock: 1 });
    });

    it('difficulty=master filters to master-only instances', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 4 });
        seedRun({ instanceId: '2', completedBy: ['p2'], difficultyTier: -1 });
        seedRun({ instanceId: '3', completedBy: ['p3'] }); // no tier = normal

        const stats = getRaidStats(24, { difficulty: 'master' });
        expect(stats).toHaveLength(1);
        expect(stats[0].classDistribution).toEqual({ Warlock: 1 });
    });

    it('difficulty=normal includes NULL and non-master tiers', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 4 });
        seedRun({ instanceId: '2', completedBy: ['p2'], difficultyTier: -1 });
        seedRun({ instanceId: '3', completedBy: ['p3'] }); // NULL tier

        const stats = getRaidStats(24, { difficulty: 'normal' });
        expect(stats).toHaveLength(1);
        expect(stats[0].classDistribution).toEqual({ Warlock: 2 });
    });

    it('exactPlayers filters to exact unique_player_count match', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p2', 'p3'], uniquePlayerCount: 2 });
        seedRun({ instanceId: '3', completedBy: ['p4', 'p5', 'p6'], uniquePlayerCount: 3 });

        const stats = getRaidStats(24, { exactPlayers: 2 });
        expect(stats).toHaveLength(1);
        expect(stats[0].classDistribution).toEqual({ Warlock: 2 });
    });

    it('maxPlayers filters by unique_player_count', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p2', 'p3'], uniquePlayerCount: 2 });
        seedRun({ instanceId: '3', completedBy: ['p4', 'p5', 'p6', 'p7'], uniquePlayerCount: 4 });

        const stats = getRaidStats(24, { maxPlayers: 2 });
        expect(stats).toHaveLength(1);
        // 1 + 2 players from the two qualifying instances
        expect(stats[0].classDistribution).toEqual({ Warlock: 3 });
    });

    it('filters compose: difficulty + maxPlayers', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 4, uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p2'], difficultyTier: 4, uniquePlayerCount: 4 });
        seedRun({ instanceId: '3', completedBy: ['p3'], difficultyTier: -1, uniquePlayerCount: 1 });

        const stats = getRaidStats(24, { difficulty: 'master', maxPlayers: 3 });
        expect(stats).toHaveLength(1);
        expect(stats[0].classDistribution).toEqual({ Warlock: 1 });
    });

    it('excludes NULL unique_player_count when maxPlayers is specified', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p2'] }); // NULL unique_player_count

        const stats = getRaidStats(24, { maxPlayers: 6 });
        expect(stats).toHaveLength(1);
        expect(stats[0].classDistribution).toEqual({ Warlock: 1 });
    });

    it('dnfRate is instance-level, not player-level', () => {
        // 1 completed instance with 3 players, 1 DNF instance with 1 player
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2', 'p3'] });
        seedRun({ instanceId: '2', incompleteBy: ['p4'], completed: false });

        const stats = getRaidStats(24);
        // 1 DNF instance out of 2 total instances = 0.5
        expect(stats[0].dnfRate).toBe(0.5);
    });

    it('groups stats independently per raid across multiple raids', () => {
        const CROTAS_END_HASH = 1566480315;
        // Salvation's Edge: fast clear (1200s), 0 DNF
        seedRun({ instanceId: '1', completedBy: ['p1'], activityHash: SALVATIONS_EDGE_HASH, activityDurationSeconds: 1200, kills: 80, deaths: 10, assists: 30 });
        // Crota's End: slower clear (3600s), 1 DNF out of 2
        seedRun({ instanceId: '2', completedBy: ['p2'], activityHash: CROTAS_END_HASH, activityDurationSeconds: 3600, kills: 40, deaths: 5, assists: 10 });
        seedRun({ instanceId: '3', incompleteBy: ['p3'], activityHash: CROTAS_END_HASH, completed: false });

        const stats = getRaidStats(24);
        expect(stats).toHaveLength(2);

        const se = stats.find(s => s.raidKey === 'salvations_edge')!;
        const ce = stats.find(s => s.raidKey === 'crotas_end')!;

        expect(se.fastestClearSeconds).toBe(1200);
        expect(se.dnfRate).toBe(0);

        expect(ce.fastestClearSeconds).toBe(3600);
        expect(ce.dnfRate).toBe(0.5);
    });

    it('returns empty array when no raids match', () => {
        const stats = getRaidStats(24);
        expect(stats).toEqual([]);
    });
});
