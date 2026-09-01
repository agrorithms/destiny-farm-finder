import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { backfill } from './gos_10k_pgcr';
import { createRunsTable } from './runs-schema';

/**
 * End-to-end smoke test for the PGCR backfill, with `fetch` stubbed.
 *
 * Kept rather than deleted after use. pgcr-parse.test.ts covers the transform,
 * but the parts that decide whether an interrupted 10k-request run is
 * recoverable — the resume key, the failure statuses, transaction atomicity, the
 * fatal-vs-instance split — only exist once the loop, the schema and the writes
 * are wired together. There is no CI for gos10k/, so this file is the only thing
 * that checks that wiring.
 *
 * Run:  npx tsx gos10k/gos_10k_pgcr.smoke.ts
 *
 * It never touches destiny_pgcrs.db: a fresh throwaway database is built in a
 * temp directory for each scenario and deleted afterwards.
 */

process.env.NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY ??= 'smoke-test-key';

const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'pgcr-17121001798.json'), 'utf8')
);


interface Scenario {
    name: string;
    /** Keyed by instance id; the value is what fetch should return. */
    responses: Record<string, { status: number; body: unknown }>;
    instanceIds: string[];
    check: (db: Database.Database, error: Error | null) => void;
    retryFailed?: boolean;
}

function seedDb(dbPath: string, instanceIds: string[]): void {
    const db = new Database(dbPath);
    // The real schema, not a retyped copy: a seeder that drifts would let these
    // scenarios pass against rows the actual crawl could never produce.
    createRunsTable(db);
    const insert = db.prepare(
        `INSERT INTO gos_10k_runs (instance_id, character_id, activity_hash, period, completed)
     VALUES (?, '123', 1042180643, ?, 1)`
    );
    instanceIds.forEach((id, i) => insert.run(id, 1700000000 + i));
    db.close();
}

/**
 * The fixture is a real payload for instance 17121001798, but each scenario
 * seeds its own ids. The id inside the payload is rewritten to match, because
 * the backfill keys every row off it and rejects a mismatch — leaving the
 * fixture's original id here would test the rejection path in every scenario
 * instead of the one that means to.
 */
function makeResponse(instanceId: string, overrides: Record<string, unknown> = {}): any {
    const body = structuredClone(golden);
    body.Response.activityDetails.instanceId = instanceId;
    Object.assign(body.Response, overrides);
    return body;
}

const scenarios: Scenario[] = [
    {
        name: 'happy path writes runs, players, weapons and the raw archive',
        instanceIds: ['1001'],
        responses: { '1001': { status: 200, body: makeResponse('1001') } },
        check: (db) => {
            const run = db.prepare(`SELECT * FROM gos_10k_runs WHERE instance_id = '1001'`).get() as any;
            assert.strictEqual(run.pgcr_fetch_status, 'ok');
            assert.ok(run.pgcr_fetched_at > 0, 'pgcr_fetched_at should be set');
            assert.strictEqual(run.starting_phase_index, 0);
            assert.strictEqual(run.activity_was_started_from_beginning, 1);
            assert.strictEqual(run.duration_seconds, 2311);
            assert.strictEqual(run.duration_disagreement, 0);
            assert.strictEqual(run.is_full_clear, 1);
            // Confirmed against the PGCR, not left at the History value.
            assert.strictEqual(run.activity_hash, 1042180643);
            assert.strictEqual(run.activity_difficulty_tier, -1);
            assert.strictEqual(run.is_private, 0);
            assert.strictEqual(run.entry_count, 8);
            assert.strictEqual(run.player_count, 8);

            const players = db.prepare(`SELECT * FROM gos_10k_pgcr_players`).all() as any[];
            assert.strictEqual(players.length, 8);
            const nesspo = players.find((p) => p.bungie_global_display_name === 'Nesspo');
            assert.strictEqual(nesspo.bungie_global_display_name_code, 9781, 'Name#Code must survive');
            assert.strictEqual(nesspo.kills, 227);
            assert.strictEqual(nesspo.grenade_kills, 4);
            assert.strictEqual(nesspo.emblem_hash, 532530778);

            const weapons = db.prepare(`SELECT COUNT(*) AS n FROM gos_10k_pgcr_weapons`).get() as any;
            assert.strictEqual(weapons.n, 35);

            // The archive must round-trip to the same payload the parse saw.
            const raw = db.prepare(`SELECT * FROM gos_10k_pgcr_raw WHERE instance_id = '1001'`).get() as any;
            const restored = JSON.parse(zlib.gunzipSync(raw.json_gz).toString('utf8'));
            assert.strictEqual(restored.entries.length, 8);
            assert.strictEqual(restored.activityDetails.instanceId, '1001');
            assert.ok(raw.json_gz.length < raw.raw_bytes, 'archive should actually be compressed');
        },
    },
    {
        name: 'a privacy-restricted instance is recorded and the run continues',
        instanceIds: ['2001', '2002'],
        responses: {
            '2001': { status: 200, body: { ErrorCode: 1665, ErrorStatus: 'DestinyPrivacyRestriction' } },
            '2002': { status: 200, body: makeResponse('2002') },
        },
        check: (db, error) => {
            assert.strictEqual(error, null, 'one bad instance must not end the run');
            const rows = db
                .prepare(`SELECT instance_id, pgcr_fetch_status FROM gos_10k_runs ORDER BY instance_id`)
                .all() as any[];
            assert.deepStrictEqual(rows, [
                { instance_id: '2001', pgcr_fetch_status: 'privacy' },
                { instance_id: '2002', pgcr_fetch_status: 'ok' },
            ]);
            // The failed instance must leave nothing half-written behind.
            const orphans = db
                .prepare(`SELECT COUNT(*) AS n FROM gos_10k_pgcr_players WHERE instance_id = '2001'`)
                .get() as any;
            assert.strictEqual(orphans.n, 0);
        },
    },
    {
        name: 'maintenance aborts the run instead of marking rows failed',
        instanceIds: ['3001', '3002'],
        responses: {
            '3001': { status: 200, body: { ErrorCode: 5, ErrorStatus: 'SystemDisabled' } },
            '3002': { status: 200, body: makeResponse('3002') },
        },
        check: (db, error) => {
            assert.ok(error, 'SystemDisabled must throw');
            assert.match(error!.message, /error:5/);
            // Neither row may be stamped: 3001 because the failure was not its
            // fault, 3002 because it was never reached. Both stay resumable.
            const unfetched = db
                .prepare(`SELECT COUNT(*) AS n FROM gos_10k_runs WHERE pgcr_fetched_at IS NULL`)
                .get() as any;
            assert.strictEqual(unfetched.n, 2);
        },
    },
    {
        name: 'a 404 is recorded as missing, not as a crash',
        instanceIds: ['4001'],
        responses: { '4001': { status: 404, body: { error: 'not found' } } },
        check: (db, error) => {
            assert.strictEqual(error, null);
            const row = db.prepare(`SELECT pgcr_fetch_status FROM gos_10k_runs`).get() as any;
            assert.strictEqual(row.pgcr_fetch_status, 'missing');
        },
    },
    {
        name: 'a non-full-clear is stored, not discarded',
        instanceIds: ['5001'],
        responses: {
            '5001': {
                status: 200,
                body: makeResponse('5001', { startingPhaseIndex: 3, activityWasStartedFromBeginning: false }),
            },
        },
        check: (db) => {
            const run = db.prepare(`SELECT * FROM gos_10k_runs`).get() as any;
            assert.strictEqual(run.starting_phase_index, 3);
            assert.strictEqual(run.activity_was_started_from_beginning, 0);
            assert.strictEqual(run.is_full_clear, 0, 'phase 3 is not a full clear');
            assert.strictEqual(run.pgcr_fetch_status, 'ok');
            // Q6: joined-in-progress runs keep their player rows. Someone who
            // joined mid-run 300 times is still part of the story, and these
            // rows cannot be recovered later without a re-crawl.
            const players = db.prepare(`SELECT COUNT(*) AS n FROM gos_10k_pgcr_players`).get() as any;
            assert.strictEqual(players.n, 8);
        },
    },
    {
        name: 'duration disagreement is flagged and the maximum is kept',
        instanceIds: ['6001'],
        responses: {
            '6001': {
                status: 200,
                body: (() => {
                    const b = makeResponse('6001');
                    b.Response.entries[0].values.activityDurationSeconds.basic.value = 99;
                    return b;
                })(),
            },
        },
        check: (db) => {
            const run = db.prepare(`SELECT * FROM gos_10k_runs`).get() as any;
            assert.strictEqual(run.duration_disagreement, 1);
            assert.strictEqual(run.duration_seconds, 2311);
        },
    },
];

async function runScenario(scenario: Scenario): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos10k-smoke-'));
    const dbPath = path.join(dir, 'smoke.db');
    seedDb(dbPath, scenario.instanceIds);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        const match = url.match(/PostGameCarnageReport\/(\d+)\//);
        assert.ok(match, `unexpected URL in smoke test: ${url}`);
        const canned = scenario.responses[match![1]!];
        assert.ok(canned, `no canned response for instance ${match![1]}`);
        return {
            status: canned.status,
            json: async () => canned.body,
        } as Response;
    }) as typeof fetch;

    let error: Error | null = null;
    try {
        await backfill({ limit: null, retryFailed: scenario.retryFailed ?? false, dbPath });
    } catch (err) {
        error = err as Error;
    } finally {
        globalThis.fetch = originalFetch;
    }

    const db = new Database(dbPath, { readonly: true });
    try {
        scenario.check(db, error);
        console.log(`  PASS  ${scenario.name}`);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Reruns must be idempotent. Verified separately because it needs two passes
 * over the same database, and because an OR REPLACE regression would show up
 * here as duplicated weapon rows rather than as a failure anywhere else.
 */
async function runIdempotencyScenario(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos10k-smoke-'));
    const dbPath = path.join(dir, 'smoke.db');
    seedDb(dbPath, ['7001']);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const id = String(input).match(/PostGameCarnageReport\/(\d+)\//)![1]!;
        return { status: 200, json: async () => makeResponse(id) } as Response;
    }) as typeof fetch;

    try {
        await backfill({ limit: null, retryFailed: false, dbPath });
        // Second pass with --retry-failed forces a refetch of the same instance.
        await backfill({ limit: null, retryFailed: true, dbPath });

        const db = new Database(dbPath, { readonly: true });
        const players = db.prepare(`SELECT COUNT(*) AS n FROM gos_10k_pgcr_players`).get() as any;
        const weapons = db.prepare(`SELECT COUNT(*) AS n FROM gos_10k_pgcr_weapons`).get() as any;
        const raw = db.prepare(`SELECT COUNT(*) AS n FROM gos_10k_pgcr_raw`).get() as any;
        db.close();

        assert.strictEqual(players.n, 8, 'rerun must not duplicate player rows');
        assert.strictEqual(weapons.n, 35, 'rerun must not duplicate weapon rows');
        assert.strictEqual(raw.n, 1, 'rerun must not duplicate archive rows');
        console.log('  PASS  a rerun is idempotent (no duplicated rows)');
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * The resume path: an already-successful row must never be refetched, because
 * that is what makes restarting an interrupted 10k run free.
 */
async function runResumeScenario(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos10k-smoke-'));
    const dbPath = path.join(dir, 'smoke.db');
    seedDb(dbPath, ['8001', '8002']);

    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const id = String(input).match(/PostGameCarnageReport\/(\d+)\//)![1]!;
        fetched.push(id);
        return { status: 200, json: async () => makeResponse(id) } as Response;
    }) as typeof fetch;

    try {
        await backfill({ limit: 1, retryFailed: false, dbPath });
        assert.deepStrictEqual(fetched, ['8001'], '--limit 1 should fetch exactly one');

        await backfill({ limit: null, retryFailed: false, dbPath });
        assert.deepStrictEqual(fetched, ['8001', '8002'], 'the second pass must skip the done row');

        console.log('  PASS  resume skips completed rows and --limit stops early');
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('gos_10k_pgcr smoke test\n');
    for (const scenario of scenarios) {
        await runScenario(scenario);
    }
    await runIdempotencyScenario();
    await runResumeScenario();
    console.log('\nAll smoke scenarios passed.');
}

main().catch((err) => {
    console.error('\nSMOKE TEST FAILED');
    console.error(err);
    process.exit(1);
});
