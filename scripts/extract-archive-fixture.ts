import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

/**
 * Extracts a small fixture Archive from the GoS 10k master into
 * tests/fixtures/archive-seed.json, which is committed and loaded into a real SQLite
 * file at test-setup time by tests/helpers/archive-seed.ts.
 *
 * JSON rather than a committed binary .db so it matches the nine PGCR fixtures already
 * in that directory — reviewable in a diff — while still testing real SQL against a
 * real file (ADR 0003).
 *
 * The rows are real, and chosen for their hazards rather than for being typical. A
 * fixture drawn only from clean completions cannot catch the bug this dataset actually
 * produces: a full-clear predicate that forgets "and he finished it" and returns a
 * number 30% high that still looks plausible. Every instance below carries a reason.
 *
 * The schema is captured from the master too, so there is no second schema definition
 * that can drift from the one the serving copy has.
 *
 *   npm run extract-archive-fixture      # needs the master; regenerate and commit
 */

const MASTER_PATH = process.env.GOS10K_MASTER_DB_PATH
    ? path.resolve(process.env.GOS10K_MASTER_DB_PATH)
    : path.join(process.cwd(), 'gos10k', 'destiny_pgcrs.db');

const OUTPUT_PATH = path.join(process.cwd(), 'tests', 'fixtures', 'archive-seed.json');

/** The pin instant. See PINNED_FULL_CLEAR in src/lib/db/archive/queries.ts. */
const PIN_INSTANCE_ID = 10141395454;

interface Target {
    instanceId: string;
    why: string;
}

const TARGETS: Target[] = [
    {
        instanceId: '10141395454',
        why: 'The pin itself: 2022-02-21, phase 0, flag 0, completed. Counted by both full-clear rules — the pinned one because it is at or before the pin and phase 0.',
    },
    {
        instanceId: '7072900493',
        why: 'Before the pin, phase 5, completed. A checkpoint run that predates the flag; counted by neither rule. Pins that "no flag" is not read as "full clear".',
    },
    {
        instanceId: '14874351447',
        why: 'After the pin, flag 1, completed. The ordinary full clear, counted by both rules.',
    },
    {
        instanceId: '14537310174',
        why: 'After the pin, flag 0 but phase 0, completed. THE case that separates the two rules: the disjunctive rule counts it, the pinned rule does not. This row is the whole 10,000-vs-10,020 difference in miniature.',
    },
    {
        instanceId: '8249673559',
        why: 'is_full_clear = 1 with completed = 0 — one of the 40 runs the fireteam cleared from the start without him. A predicate that drops the completed conjunct counts this and is wrong by a margin small enough to look right.',
    },
    {
        instanceId: '10014833110',
        why: 'A player brought more than one character. Any count over gos_10k_pgcr_players that is not COUNT(DISTINCT instance_id) inflates on this row.',
    },
    {
        instanceId: '7085305400',
        why: 'Carries a player with a NULL bungie_global_display_name_code. Formatting must fall back rather than render "Name#null".',
    },
    {
        instanceId: '14874226958',
        why: 'source = get_activity_history_unfiltered, completed = 0 — a run he started and abandoned. The population that only exists after the 2026-09-03 crawl; a Run is not a completion.',
    },
    {
        instanceId: '14874038172',
        why: 'A second unfiltered incomplete run, so aggregates over the abandoned population are not a single row.',
    },
];

const TABLES = ['gos_10k_runs', 'gos_10k_pgcr_players', 'gos_10k_pgcr_weapons'] as const;

function main(): void {
    if (!fs.existsSync(MASTER_PATH)) {
        throw new Error(`No master at ${MASTER_PATH}. Set GOS10K_MASTER_DB_PATH to point elsewhere.`);
    }

    const db = new Database(MASTER_PATH, { readonly: true, fileMustExist: true });
    const ids = TARGETS.map((t) => t.instanceId);
    const placeholders = ids.map(() => '?').join(', ');

    // Captured, not hand-written: the fixture's schema is the master's schema by
    // construction, so it cannot drift from what the serving copy actually has.
    const schema = (db.prepare(`
        SELECT sql FROM sqlite_master
        WHERE sql IS NOT NULL AND tbl_name IN (${TABLES.map(() => '?').join(', ')})
        ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name
    `).all(...TABLES) as Array<{ sql: string }>).map((row) => row.sql);

    const tables: Record<string, unknown[]> = {};
    for (const table of TABLES) {
        tables[table] = db.prepare(
            `SELECT * FROM ${table} WHERE instance_id IN (${placeholders}) ORDER BY instance_id`
        ).all(...ids);
    }

    const missing = ids.filter(
        (id) => !(tables.gos_10k_runs as Array<{ instance_id: string }>).some((r) => r.instance_id === id)
    );
    if (missing.length > 0) {
        throw new Error(`Not in the master: ${missing.join(', ')}. The targets are stale.`);
    }

    db.close();

    const seed = {
        generatedAt: new Date().toISOString(),
        generatedBy: 'scripts/extract-archive-fixture.ts',
        source: path.relative(process.cwd(), MASTER_PATH),
        pinInstanceId: String(PIN_INSTANCE_ID),
        targets: TARGETS,
        schema,
        tables,
    };

    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(seed, null, 4)}\n`);

    console.log(`📝 ${path.relative(process.cwd(), OUTPUT_PATH)}`);
    for (const table of TABLES) {
        console.log(`   ${table.padEnd(24)} ${String(tables[table].length).padStart(5)} rows`);
    }
}

main();
