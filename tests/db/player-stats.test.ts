import { describe, it, expect, beforeEach } from 'vitest';
import { resetTestDb } from '../helpers/db';
import { seedRun, hoursAgo } from '../helpers/seed';
import { getPlayerRaidPerformanceStats } from '../../src/lib/db/queries';

beforeEach(() => { resetTestDb(); });

describe('getPlayerRaidPerformanceStats', () => {
    it('sums kills, deaths, assists across all attempts and computes KDA', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], kills: 50, deaths: 5, assists: 10 });
        seedRun({ instanceId: '2', completedBy: ['p1'], kills: 30, deaths: 3, assists: 20 });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        expect(stats).toHaveLength(1);
        expect(stats[0].kills).toBe(80);
        expect(stats[0].deaths).toBe(8);
        expect(stats[0].assists).toBe(30);
        // KDA = (80 + 30) / max(8, 1) = 13.75
        expect(stats[0].kda).toBe(13.75);
    });

    it('fastestClearSeconds picks the minimum completed full-clear duration', () => {
        // 3600s run
        seedRun({
            instanceId: '1', completedBy: ['p1'],
            period: hoursAgo(3), activityDurationSeconds: 3600,
        });
        // 1200s run — should be fastest
        seedRun({
            instanceId: '2', completedBy: ['p1'],
            period: hoursAgo(2), activityDurationSeconds: 1200,
        });
        // 2400s run
        seedRun({
            instanceId: '3', completedBy: ['p1'],
            period: hoursAgo(1), activityDurationSeconds: 2400,
        });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        expect(stats[0].fastestClearSeconds).toBe(1200);
    });

    it('dnfRate includes incomplete attempts even when the raid has completions', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'] });
        seedRun({ instanceId: '2', incompleteBy: ['p1'] });
        seedRun({ instanceId: '3', incompleteBy: ['p1'] });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        expect(stats).toHaveLength(1);
        // 2 incomplete out of 3 total
        expect(stats[0].dnfRate).toBeCloseTo(2 / 3, 4);
    });

    it('dnfRate is the fraction of attempts where the player did not complete', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'] });
        seedRun({ instanceId: '2', completedBy: ['p1'] });
        seedRun({ instanceId: '3', incompleteBy: ['p1'] });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        // 1 incomplete out of 3 total = 0.3333
        expect(stats[0].dnfRate).toBeCloseTo(1 / 3, 4);
    });

    it('dnfRate is 0 when all attempts are completed', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'] });
        seedRun({ instanceId: '2', completedBy: ['p1'] });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        expect(stats[0].dnfRate).toBe(0);
    });

    it('excludes raids where the player has only incomplete attempts', () => {
        seedRun({ instanceId: '1', incompleteBy: ['p1'] });
        seedRun({ instanceId: '2', incompleteBy: ['p1'] });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        expect(stats).toEqual([]);
    });

    it('excludes runs outside the time window', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], period: hoursAgo(2), kills: 50, deaths: 5, assists: 10 });
        seedRun({ instanceId: '2', completedBy: ['p1'], period: hoursAgo(10), kills: 200, deaths: 20, assists: 80 });

        const stats = getPlayerRaidPerformanceStats('p1', 4);
        expect(stats).toHaveLength(1);
        expect(stats[0].kills).toBe(50);
    });

    it('returns stats grouped by raid', () => {
        const SALVATIONS_EDGE_HASH = 2192826039;
        const CROTAS_END_HASH = 1566480315;
        seedRun({ instanceId: '1', completedBy: ['p1'], activityHash: SALVATIONS_EDGE_HASH, kills: 60, deaths: 4, assists: 20 });
        seedRun({ instanceId: '2', completedBy: ['p1'], activityHash: CROTAS_END_HASH, kills: 30, deaths: 2, assists: 10 });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        expect(stats).toHaveLength(2);
        const keys = stats.map(s => s.raidKey);
        expect(keys).toContain('salvations_edge');
        expect(keys).toContain('crotas_end');
    });

    it('KDA handles zero deaths as max(deaths, 1)', () => {
        seedRun({ instanceId: '1', completedBy: ['p1'], kills: 50, deaths: 0, assists: 10 });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        // (50 + 10) / max(0, 1) = 60
        expect(stats[0].kda).toBe(60);
    });

    it('fastestClearSeconds ignores checkpoint runs', () => {
        seedRun({
            instanceId: '1', completedBy: ['p1'],
            activityDurationSeconds: 600, startedFromBeginning: false,
        });
        seedRun({
            instanceId: '2', completedBy: ['p1'],
            activityDurationSeconds: 1800, startedFromBeginning: true,
        });

        const stats = getPlayerRaidPerformanceStats('p1', 24);
        expect(stats[0].fastestClearSeconds).toBe(1800);
    });

    it('counts only the target player stats in a multi-player fireteam', () => {
        seedRun({
            instanceId: '1',
            completedBy: ['target', 'teammate1', 'teammate2'],
            kills: 40, deaths: 5, assists: 15,
        });

        const stats = getPlayerRaidPerformanceStats('target', 24);
        expect(stats).toHaveLength(1);
        // Only target's row: 40 kills, not 120 (3 × 40)
        expect(stats[0].kills).toBe(40);
        expect(stats[0].deaths).toBe(5);
        expect(stats[0].assists).toBe(15);
    });

    it('returns empty array when player has no runs', () => {
        const stats = getPlayerRaidPerformanceStats('nobody', 24);
        expect(stats).toEqual([]);
    });
});
