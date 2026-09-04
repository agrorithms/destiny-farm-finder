import { describe, it, expect, beforeEach } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { seedRun, hoursAgo } from '../helpers/seed';
import { getRaidStats } from '../../src/lib/db/queries';

beforeEach(() => { resetTestDb(); });

const SALVATIONS_EDGE_HASH = 2192826039;

describe('getRaidStats', () => {
    it('returns per-raid fastest clear and DNF rate', () => {
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

    // Replaces the old `avgKda` assertion. That field was a mean of per-player ratios;
    // aggregateKda is ratio-of-sums over the same population, so the number differs.
    it('reports aggregateKda as ratio-of-sums, not a mean of per-player ratios', () => {
        // p1: (80+30)/10 = 11.0, p2: (10+0)/1 = 10.0 — mean of ratios would be 10.5
        seedRun({ instanceId: '1', completedBy: ['p1'], kills: 80, deaths: 10, assists: 30 });
        seedRun({ instanceId: '2', completedBy: ['p2'], kills: 10, deaths: 1, assists: 0 });

        const stats = getRaidStats(24);
        // (80+10 + 30+0) / (10+1) = 120/11 = 10.909...
        expect(stats[0].fullClear.aggregateKda).toBe(10.91);
        expect(stats[0].fullClear.sampleSize).toBe(2);
    });

    it('returns class distribution as counts per class', () => {
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2', 'p3'] });

        const stats = getRaidStats(24);
        // seedRun defaults all players to Warlock
        expect(stats[0].allAttempts.classDistribution).toEqual({ Warlock: 3 });
    });

    it('respects the hours time window', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], period: hoursAgo(2) });
        seedRun({ instanceId: '2', completedBy: ['p2'], period: hoursAgo(10) });

        const stats = getRaidStats(4);
        // Only one instance in window, so one player total
        expect(stats[0].allAttempts.classDistribution).toEqual({ Warlock: 1 });
    });

    it('difficulty=master filters to master-only instances', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 4 });
        seedRun({ instanceId: '2', completedBy: ['p2'], difficultyTier: -1 });
        seedRun({ instanceId: '3', completedBy: ['p3'] }); // no tier = normal

        const stats = getRaidStats(24, { difficulty: 'master' });
        expect(stats).toHaveLength(1);
        expect(stats[0].allAttempts.classDistribution).toEqual({ Warlock: 1 });
    });

    it('difficulty=normal includes NULL and non-master tiers', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 4 });
        seedRun({ instanceId: '2', completedBy: ['p2'], difficultyTier: -1 });
        seedRun({ instanceId: '3', completedBy: ['p3'] }); // NULL tier

        const stats = getRaidStats(24, { difficulty: 'normal' });
        expect(stats).toHaveLength(1);
        expect(stats[0].allAttempts.classDistribution).toEqual({ Warlock: 2 });
    });

    it('exactPlayers filters to exact unique_player_count match', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p2', 'p3'], uniquePlayerCount: 2 });
        seedRun({ instanceId: '3', completedBy: ['p4', 'p5', 'p6'], uniquePlayerCount: 3 });

        const stats = getRaidStats(24, { exactPlayers: 2 });
        expect(stats).toHaveLength(1);
        expect(stats[0].allAttempts.classDistribution).toEqual({ Warlock: 2 });
    });

    it('maxPlayers filters by unique_player_count', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p2', 'p3'], uniquePlayerCount: 2 });
        seedRun({ instanceId: '3', completedBy: ['p4', 'p5', 'p6', 'p7'], uniquePlayerCount: 4 });

        const stats = getRaidStats(24, { maxPlayers: 2 });
        expect(stats).toHaveLength(1);
        // 1 + 2 players from the two qualifying instances
        expect(stats[0].allAttempts.classDistribution).toEqual({ Warlock: 3 });
    });

    it('filters compose: difficulty + maxPlayers', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], difficultyTier: 4, uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p2'], difficultyTier: 4, uniquePlayerCount: 4 });
        seedRun({ instanceId: '3', completedBy: ['p3'], difficultyTier: -1, uniquePlayerCount: 1 });

        const stats = getRaidStats(24, { difficulty: 'master', maxPlayers: 3 });
        expect(stats).toHaveLength(1);
        expect(stats[0].allAttempts.classDistribution).toEqual({ Warlock: 1 });
    });

    it('excludes NULL unique_player_count when maxPlayers is specified', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], uniquePlayerCount: 1 });
        seedRun({ instanceId: '2', completedBy: ['p2'] }); // NULL unique_player_count

        const stats = getRaidStats(24, { maxPlayers: 6 });
        expect(stats).toHaveLength(1);
        expect(stats[0].allAttempts.classDistribution).toEqual({ Warlock: 1 });
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

    it('picks quartiles by nearest rank, so every percentile is a real observation', () => {
        // Four single-player full clears with KDAs 1, 2, 3, 4 (deaths = 1, assists = 0).
        // Nearest rank: ceil(0.25*4)=1, ceil(0.50*4)=2, ceil(0.75*4)=3.
        for (const [i, kills] of [1, 2, 3, 4].entries()) {
            seedRun({ instanceId: String(i + 1), completedBy: [`p${i + 1}`], kills, deaths: 1, assists: 0 });
        }

        const stats = getRaidStats(24);
        expect(stats[0].fullClear.sampleSize).toBe(4);
        expect(stats[0].fullClear.kda).toEqual({ p25: 1, p50: 2, p75: 3 });
    });

    it('collapses all three quartiles onto the single observation at n=1', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], kills: 40, deaths: 5, assists: 10 });

        const stats = getRaidStats(24);
        expect(stats[0].fullClear.sampleSize).toBe(1);
        // (40+10)/5 = 10
        expect(stats[0].fullClear.kda).toEqual({ p25: 10, p50: 10, p75: 10 });
    });

    it('at n=2 gives p25 = p50 = lower and p75 = upper, so both raw values are recoverable', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], kills: 10, deaths: 1, assists: 0 });
        seedRun({ instanceId: '2', completedBy: ['p2'], kills: 20, deaths: 1, assists: 0 });

        const stats = getRaidStats(24);
        expect(stats[0].fullClear.kda).toEqual({ p25: 10, p50: 10, p75: 20 });
    });

    it('divides by max(deaths, 1) per Player-Run so a flawless run does not divide by zero', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], kills: 30, deaths: 0, assists: 0 });

        const stats = getRaidStats(24);
        expect(stats[0].fullClear.kda).toEqual({ p25: 30, p50: 30, p75: 30 });
        // The aggregate guard is MAX(SUM(deaths), 1), which fires on the same input here.
        expect(stats[0].fullClear.aggregateKda).toBe(30);
    });

    it('returns kda null exactly when a scope has no Player-Runs', () => {
        // A DNF-only instance: the raid is in-window, but nothing qualifies as a full clear.
        seedRun({ instanceId: '1', incompleteBy: ['p1'], completed: false });

        const stats = getRaidStats(24);
        expect(stats).toHaveLength(1);
        expect(stats[0].fullClear.sampleSize).toBe(0);
        expect(stats[0].fullClear.kda).toBeNull();
        expect(stats[0].fullClear.aggregateKda).toBeNull();
        expect(stats[0].fullClear.classDistribution).toEqual({});
        // The same raid still has Player-Runs under the broader scope.
        expect(stats[0].allAttempts.sampleSize).toBe(1);
        expect(stats[0].allAttempts.kda).not.toBeNull();
    });

    it('reports the two scopes as different populations for the same raid', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], kills: 100, deaths: 1, assists: 0 });
        seedRun({ instanceId: '2', incompleteBy: ['p2'], completed: false, kills: 0, deaths: 10, assists: 0 });

        const stats = getRaidStats(24);
        const row = stats[0];

        expect(row.fullClear.sampleSize).toBe(1);
        expect(row.fullClear.kda).toEqual({ p25: 100, p50: 100, p75: 100 });
        expect(row.fullClear.aggregateKda).toBe(100);

        expect(row.allAttempts.sampleSize).toBe(2);
        // Sorted KDAs are [0, 100]: nearest rank puts p25 and p50 on the DNF run.
        expect(row.allAttempts.kda).toEqual({ p25: 0, p50: 0, p75: 100 });
        // (100+0)/(1+10) = 9.09
        expect(row.allAttempts.aggregateKda).toBe(9.09);
    });

    it('counts instances in instanceCount and Player-Runs in sampleSize', () => {
        // 2 instances, 4 Player-Runs — the two counts are in different units.
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2', 'p3'] });
        seedRun({ instanceId: '2', incompleteBy: ['p4'], completed: false });

        const stats = getRaidStats(24);
        expect(stats[0].instanceCount).toBe(2);
        expect(stats[0].allAttempts.sampleSize).toBe(4);
        expect(stats[0].fullClear.sampleSize).toBe(3);
    });

    it('class counts sum to sampleSize within each scope, since they are one population', () => {
        seedRun({ instanceId: '1', completedBy: ['p1', 'p2'] });
        seedRun({ instanceId: '2', completedBy: ['p3'], incompleteBy: ['p4'] });
        seedRun({ instanceId: '3', incompleteBy: ['p5'], completed: false });

        const stats = getRaidStats(24);
        for (const scope of [stats[0].fullClear, stats[0].allAttempts]) {
            const total = Object.values(scope.classDistribution).reduce((a, b) => a + b, 0);
            expect(total).toBe(scope.sampleSize);
        }
    });
});
