import { getArchiveDb } from './index';
import { formatBungieDisplayName } from '../queries';

/**
 * All SQL for the GoS 10k Archive. One query module per database — the Tracker's is
 * ../queries.ts over getDb(), this one is over getArchiveDb(), and the two are never
 * joined. Keeping them apart is not style: ../queries.ts is ~1,700 lines over an
 * implicit connection, and a second database mixed into it would make "which database
 * is this function reading" a per-function question.
 *
 * Three hazards in this data have their single home here. Read them before adding a
 * query; each one produces a plausible wrong number rather than an error.
 */

/**
 * Nesspo#9781 — the player whose history this Archive is. Every Run row is one of his
 * runs, so `gos_10k_runs.completed` means *he* finished, while
 * `gos_10k_pgcr_players.completed` means whichever player that row is finished. The
 * two are different questions and the column names do not say so.
 */
export const SUBJECT_MEMBERSHIP_ID = '4611686018437585442';

/**
 * HAZARD 1 — 217 (instance, player) pairs have more than one row in
 * `gos_10k_pgcr_players`, because a player can bring several characters to one raid.
 * Anything counting runs through that table must COUNT(DISTINCT instance_id) or it
 * silently inflates. This is the single most likely bug in the feature.
 *
 * HAZARD 2 — 174 player rows have a NULL `bungie_global_display_name_code`. Format
 * names through formatBungieDisplayName() (../queries.ts), which already implements
 * the fallback ladder. Do not write a second display rule; `Name#Code` in full, always.
 *
 * HAZARD 3 — the full-clear predicates below. See their own comments.
 */

/**
 * **Pinned Full Clear** — the Archive's default, and the rule that reconciles to
 * exactly 10,000.
 *
 * Bungie did not populate `activityWasStartedFromBeginning` for the whole of the
 * covered history: zero runs at or before 2022-02-21 carry it. So the rule trusts the
 * flag after the pin and `starting_phase_index = 0` at or before it. The pin instant
 * is instance 10141395454 — the subject's own last clear before a 40-day gap with no
 * GoS runs at all, which is where the evidence runs out. **The id means nothing else**;
 * it is not a boundary Bungie chose, and a future reader should not look for one.
 *
 * The 7 runs between the two candidate pins (2022-04-02 to 04-05) are all phase 0,
 * flag 0, and raid.report independently shows them as checkpoint runs — which is why
 * pinning at Feb 21 rather than at the first observed `flag = 1` (2022-04-09) is
 * right. That later date is the first *true* reading, not the first meaningful one.
 *
 * The stored `is_full_clear` column holds exactly this rule, so it is what the SQL
 * reads; the CASE is documented here rather than repeated at every call site.
 *
 * `completed = 1` is inside the predicate, not left to the caller. Without it this
 * returns 12,937 — 30% high, and plausible. `is_full_clear = 1` alone returns 10,040:
 * 40 runs the fireteam cleared from the start *without* him, correctly flagged. The
 * gap narrowing from 3,400 rows to 40 makes the bug harder to notice, not less real.
 */
export const PINNED_FULL_CLEAR = 'r.is_full_clear = 1 AND r.completed = 1';

/**
 * **Disjunctive Full Clear** — the Tracker-comparable rule. Flag set *or* phase index
 * 0, anywhere in the history, with no pin. **10,020**: generous by 20 runs against
 * {@link PINNED_FULL_CLEAR}, all of them before the flag was reliable.
 *
 * Kept because the comparison is the interesting thing, and because which number the
 * page headlines is an editorial choice that stays a call site rather than a schema
 * change. Both inputs are stored per row. Carries `completed = 1` for the same reason
 * as its sibling — without it, 13,412.
 */
export const DISJUNCTIVE_FULL_CLEAR =
    '(r.activity_was_started_from_beginning = 1 OR r.starting_phase_index = 0) AND r.completed = 1';

/**
 * Runs he started from the first encounter, whatever became of them.
 *
 * Deliberately **not** the negation of `is_full_clear`: the stored column folds in
 * "at least one player completed", so 2,897 started-from-the-start runs nobody
 * finished read `is_full_clear = 0`. Any question about *attempts* — wipes, abandoned
 * runs, how long a failed run lasted — must read the two raw columns like this.
 */
export const STARTED_FROM_BEGINNING =
    '(r.activity_was_started_from_beginning = 1 OR r.starting_phase_index = 0)';

export interface ArchiveOverview {
    /** Every raid instance he entered, completed or not. */
    runs: number;
    /** Runs he personally finished, whatever encounter he joined at. */
    completions: number;
    /** {@link PINNED_FULL_CLEAR} — the headline candidate. */
    pinnedFullClears: number;
    /** {@link DISJUNCTIVE_FULL_CLEAR} — the Tracker-comparable cross-tab. */
    disjunctiveFullClears: number;
    /** Distinct people who appeared in at least one of his runs, excluding him. */
    helpers: number;
    firstRunAt: number | null;
    lastRunAt: number | null;
}

export function getArchiveOverview(): ArchiveOverview {
    const db = getArchiveDb();

    const runs = db.prepare(`
        SELECT
            COUNT(*) AS runs,
            SUM(CASE WHEN r.completed = 1 THEN 1 ELSE 0 END) AS completions,
            SUM(CASE WHEN ${PINNED_FULL_CLEAR} THEN 1 ELSE 0 END) AS pinnedFullClears,
            SUM(CASE WHEN ${DISJUNCTIVE_FULL_CLEAR} THEN 1 ELSE 0 END) AS disjunctiveFullClears,
            MIN(r.period) AS firstRunAt,
            MAX(r.period) AS lastRunAt
        FROM gos_10k_runs r
    `).get() as {
        runs: number;
        completions: number | null;
        pinnedFullClears: number | null;
        disjunctiveFullClears: number | null;
        firstRunAt: number | null;
        lastRunAt: number | null;
    };

    const helpers = db.prepare(`
        SELECT COUNT(DISTINCT p.membership_id) AS n
        FROM gos_10k_pgcr_players p
        WHERE p.membership_id != ?
    `).get(SUBJECT_MEMBERSHIP_ID) as { n: number };

    return {
        runs: runs.runs,
        completions: runs.completions ?? 0,
        pinnedFullClears: runs.pinnedFullClears ?? 0,
        disjunctiveFullClears: runs.disjunctiveFullClears ?? 0,
        helpers: helpers.n,
        firstRunAt: runs.firstRunAt,
        lastRunAt: runs.lastRunAt,
    };
}

export interface ArchiveHelper {
    membershipId: string;
    membershipType: number;
    /** `Name#Code` in full, via formatBungieDisplayName. */
    displayName: string;
    /** Runs of his they appeared in. Distinct instances, never player rows. */
    runs: number;
    /** Of those, the ones that were a Pinned Full Clear. */
    fullClears: number;
}

/**
 * The Helpers who show up in most of his runs.
 *
 * `COUNT(DISTINCT r.instance_id)` rather than `COUNT(*)`: hazard 1. A player who
 * brought three characters to one raid has three rows here and is still one run.
 */
export function getTopHelpers(limit: number = 25): ArchiveHelper[] {
    const rows = getArchiveDb().prepare(`
        SELECT
            p.membership_id                     AS membershipId,
            MAX(p.membership_type)              AS membershipType,
            MAX(p.display_name)                 AS displayName,
            MAX(p.bungie_global_display_name)   AS bungieGlobalDisplayName,
            MAX(p.bungie_global_display_name_code) AS bungieGlobalDisplayNameCode,
            COUNT(DISTINCT r.instance_id)       AS runs,
            COUNT(DISTINCT CASE WHEN ${PINNED_FULL_CLEAR} THEN r.instance_id END) AS fullClears
        FROM gos_10k_pgcr_players p
        JOIN gos_10k_runs r ON r.instance_id = p.instance_id
        WHERE p.membership_id != ?
        GROUP BY p.membership_id
        ORDER BY runs DESC, fullClears DESC, membershipId
        LIMIT ?
    `).all(SUBJECT_MEMBERSHIP_ID, limit) as Array<{
        membershipId: string;
        membershipType: number;
        displayName: string | null;
        bungieGlobalDisplayName: string | null;
        bungieGlobalDisplayNameCode: number | null;
        runs: number;
        fullClears: number;
    }>;

    return rows.map((row) => ({
        membershipId: row.membershipId,
        membershipType: row.membershipType,
        displayName: formatBungieDisplayName(row),
        runs: row.runs,
        fullClears: row.fullClears,
    }));
}

export interface ArchiveYear {
    year: string;
    runs: number;
    fullClears: number;
}

/**
 * Pinned Full Clears by calendar year, alongside every run he started. The gap between
 * the two columns is the attempt story — checkpoint farms and wipes — which is why
 * both are here rather than only the clears.
 */
export function getRunsByYear(): ArchiveYear[] {
    return getArchiveDb().prepare(`
        SELECT
            strftime('%Y', r.period, 'unixepoch') AS year,
            COUNT(*) AS runs,
            SUM(CASE WHEN ${PINNED_FULL_CLEAR} THEN 1 ELSE 0 END) AS fullClears
        FROM gos_10k_runs r
        GROUP BY year
        ORDER BY year
    `).all() as ArchiveYear[];
}

export interface ArchiveClassCount {
    characterClass: string;
    playerRuns: number;
}

/**
 * Class split across every player-run in the Archive.
 *
 * `character_class` is stored as text, which is why this works today — every other
 * cosmetic dimension (weapon, emblem, race, gender) is a manifest hash with no
 * resolution script written yet.
 */
export function getClassDistribution(): ArchiveClassCount[] {
    return getArchiveDb().prepare(`
        SELECT
            COALESCE(p.character_class, 'Unknown') AS characterClass,
            COUNT(*) AS playerRuns
        FROM gos_10k_pgcr_players p
        GROUP BY characterClass
        ORDER BY playerRuns DESC
    `).all() as ArchiveClassCount[];
}
