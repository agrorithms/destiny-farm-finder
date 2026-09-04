import { beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureArchive, readArchiveSeed } from '../helpers/archive-seed';
import { closeArchiveDb } from '@/lib/db/archive';
import {
    getArchiveOverview,
    getTopHelpers,
    getClassDistribution,
    getRunsByYear,
} from '@/lib/db/archive/queries';

/**
 * Pins the Archive's two full-clear rules against each other, and the three data
 * hazards documented in src/lib/db/archive/queries.ts.
 *
 * The fixture is nine real runs from the master, chosen because each one is a case
 * where a plausible-looking query gives the wrong answer — read `targets` in
 * tests/fixtures/archive-seed.json. What makes the pair worth testing together is that
 * neither rule is wrong: the pinned rule reconciles to 10,000 and the disjunctive rule
 * to 10,020 on the real data, and a change that quietly collapses them onto one another
 * still returns a number that looks right.
 */

beforeAll(() => {
    // Build before the first getArchiveDb(): the connection is a per-process singleton,
    // so a rebuild under an open handle would leave the old snapshot in memory.
    closeArchiveDb();
    buildFixtureArchive();
});

describe('the Archive fixture', () => {
    it('is the throwaway file, built from the committed seed', () => {
        const seed = readArchiveSeed();
        expect(seed.tables.gos_10k_runs).toHaveLength(9);
        expect(getArchiveOverview().runs).toBe(9);
    });
});

describe('the two full-clear rules', () => {
    it('disagree by exactly the flag-0 / phase-0 run after the pin', () => {
        const overview = getArchiveOverview();

        // 14537310174: after the pin, flag 0, phase 0, completed. The disjunctive rule
        // reads phase 0 as a fresh start; the pinned rule trusts only the flag once the
        // flag is live. That single row is the 10,000-vs-10,020 difference in miniature.
        expect(overview.disjunctiveFullClears - overview.pinnedFullClears).toBe(1);
    });

    it('both exclude the run he did not finish himself', () => {
        const overview = getArchiveOverview();

        // 8249673559 carries is_full_clear = 1 with completed = 0 — the fireteam cleared
        // from the start without him. Dropping the completed conjunct from either rule
        // adds it, which on the real data is a 0.4% error: too small to notice, and the
        // exact reason the conjunct lives inside the named predicate.
        expect(overview.completions).toBe(6);
        expect(overview.pinnedFullClears).toBe(4);
        expect(overview.disjunctiveFullClears).toBe(5);
        // Five of the nine runs carry is_full_clear = 1, and one of those five is
        // 8249673559. Reading the stored column alone gives 5, not 4.
        expect(readArchiveSeed().tables.gos_10k_runs.filter((run) => run.is_full_clear === 1))
            .toHaveLength(5);
    });

    it('count a pre-pin phase-0 run and reject a pre-pin checkpoint run', () => {
        // Before 2022-02-21 no run carries the flag at all, so a rule reading the flag
        // alone would return zero clears for the first two years of the dataset.
        // 2020 holds both pre-pin runs: 7085305400 at phase 0 (a clear) and 7072900493
        // at phase 5 (a checkpoint run). Neither carries the flag, because no run before
        // 2022-02-21 does.
        expect(getRunsByYear()).toContainEqual({ year: '2020', runs: 2, fullClears: 1 });
    });
});

describe('the data hazards', () => {
    it('counts a helper once per run however many characters they brought', () => {
        const helpers = getTopHelpers(100);

        // 10014833110 has a player with two character rows. COUNT(*) would give them
        // one more run than they played.
        const totalRuns = helpers.reduce((sum, helper) => sum + helper.runs, 0);
        const playerRows = readArchiveSeed().tables.gos_10k_pgcr_players.length;
        expect(totalRuns).toBeLessThan(playerRows);

        for (const helper of helpers) {
            expect(helper.runs).toBeLessThanOrEqual(getArchiveOverview().runs);
            expect(helper.fullClears).toBeLessThanOrEqual(helper.runs);
        }
    });

    it('never renders a name with a missing code as Name#null', () => {
        // 7085305400 carries a player whose bungie_global_display_name_code is NULL.
        for (const helper of getTopHelpers(100)) {
            expect(helper.displayName).not.toContain('#null');
            expect(helper.displayName).not.toContain('undefined');
            expect(helper.displayName.length).toBeGreaterThan(0);
        }
    });

    it('excludes the subject from the helper list', () => {
        const helpers = getTopHelpers(100);
        expect(helpers.some((helper) => helper.membershipId === '4611686018437585442')).toBe(false);
    });

    it('reports a class for every player-run, unknown included', () => {
        const distribution = getClassDistribution();
        const total = distribution.reduce((sum, row) => sum + row.playerRuns, 0);
        expect(total).toBe(readArchiveSeed().tables.gos_10k_pgcr_players.length);
    });
});

describe('a Run is not a completion', () => {
    it('counts runs he abandoned alongside the ones he finished', () => {
        const overview = getArchiveOverview();

        // The 2026-09-03 crawl added 3,397 runs he started and did not complete. Before
        // it, every row in this table was a completion and `AND he completed it` was
        // implicit and free. It is neither now.
        expect(overview.runs).toBeGreaterThan(overview.completions);
    });
});
