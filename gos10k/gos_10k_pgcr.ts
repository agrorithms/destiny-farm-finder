import 'dotenv/config';
import path from 'path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { createBungieFetch } from './bungie-fetch';
import { classifyPgcrOutcome } from './pgcr-errors';
import { parsePgcr, type RawPgcrResponse } from './pgcr-parse';

/**
 * One-time PGCR detail pass over the rows gos_10k.ts collected.
 *
 * gos_10k_runs is a *superset* of true full clears: Activity History carries
 * neither activityWasStartedFromBeginning nor startingPhaseIndex, so runs joined
 * in progress are in there too. This script fetches the real PGCR for each row,
 * backfills those two fields plus the duration, and stores the per-player and
 * per-weapon detail that Activity History never had.
 *
 * Design decisions worth knowing before editing (settled in a grilling session,
 * 2026-09-01; the reasoning is inline at each site):
 *
 *   - The raw Response is archived gzipped. This crawl happens once against a
 *     rate-limited API; the parse can be corrected forever from local data.
 *   - "Not fetched" and "fetched, no usable value" are different states and get
 *     different columns. A NULL-only resume key would conflate them.
 *   - Nothing is deleted. A run that turns out not to be a full clear keeps its
 *     player rows — someone who joined him mid-run 300 times is still part of
 *     the story, and those rows are not recoverable without a re-crawl.
 *   - The 10,000 is reported, never asserted. It is a hypothesis about the data,
 *     and a script that fails on it invites tuning the predicate until it passes.
 */

const CONFIG = {
    dbPath: path.join(__dirname, 'destiny_pgcrs.db'),
    maxRequestsPerSecond: 24,
    /**
     * The account the 10k belongs to — Nesspo#9781. Used only for the final
     * cross-tab: "did the target player personally complete this run", which is
     * a different question from "did anyone complete it".
     */
    targetMembershipId: '4611686018437585442',
    targetName: 'Nesspo#9781',
    /**
     * Consecutive per-instance failures that end the run. Any single instance
     * may legitimately fail; twenty-five in a row is the API, not the data, and
     * carrying on would mark thousands of rows failed for one systemic cause.
     */
    consecutiveFailureLimit: 25,
    progressEvery: 250,
};

// Resolved when the backfill actually runs, not at import time. Importing a
// module must not throw: the smoke test imports this file to drive backfill()
// with a stubbed fetch, and a module-level throw would make that impossible.
function apiHeaders(): Record<string, string> {
    const key = process.env.NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY;
    if (!key) {
        throw new Error('NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY is not set. Add it to .env at the repo root.');
    }
    return { 'X-API-Key': key };
}

const { fetchRaw } = createBungieFetch(CONFIG.maxRequestsPerSecond);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
    limit: number | null;
    retryFailed: boolean;
    dbPath: string;
}

function parseArgs(argv: string[]): Options {
    const opts: Options = { limit: null, retryFailed: false, dbPath: CONFIG.dbPath };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--limit') {
            const raw = argv[++i];
            const n = Number(raw);
            if (!Number.isInteger(n) || n <= 0) {
                throw new Error(`--limit needs a positive integer, got "${raw}"`);
            }
            opts.limit = n;
        } else if (arg === '--retry-failed') {
            opts.retryFailed = true;
        } else if (arg === '--db') {
            // Exists for the smoke test, which must never touch the real file.
            const raw = argv[++i];
            if (!raw) throw new Error('--db needs a path');
            opts.dbPath = raw;
        } else if (arg !== undefined) {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return opts;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initPgcrSchema(db: Database.Database): void {
    // Per-connection, and it must be set outside a transaction. Without it every
    // FOREIGN KEY below is decorative.
    db.pragma('foreign_keys = ON');

    // Guarded ALTER, same idiom as src/lib/db/schema.ts: CREATE TABLE IF NOT
    // EXISTS is a no-op on the existing gos_10k_runs, so new columns need this.
    //
    // None of these carry a DEFAULT. An earlier version of this table had
    // `starting_phase_index INTEGER DEFAULT 0`, which made "not yet checked"
    // indistinguishable from "phase 0" — and SQLite cannot drop a default via
    // ALTER TABLE, so the fix was deleting the database. NULL means unknown here
    // and must keep meaning that.
    const existing = new Set(
        (db.prepare(`PRAGMA table_info(gos_10k_runs)`).all() as Array<{ name: string }>).map((c) => c.name)
    );

    const newColumns: Array<[string, string]> = [
        // NULL = never attempted. This is the resume key.
        ['pgcr_fetched_at', 'INTEGER'],
        // 'ok' | 'privacy' | 'missing' | 'error:<code>' | 'http:<status>'
        ['pgcr_fetch_status', 'TEXT'],
        ['activity_difficulty_tier', 'INTEGER'],
        ['is_private', 'INTEGER'],
        // Rows in entries[]. Distinct from player_count (distinct memberships):
        // the gap is mid-run substitutions, and collapsing them erases those.
        ['entry_count', 'INTEGER'],
        // 1 when entries disagreed on activityDurationSeconds. Instrumented
        // rather than assumed — the last unverified field semantics on this
        // project (completionReason) did not survive contact with the data.
        ['duration_disagreement', 'INTEGER'],
        // The full-clear verdict, written from parsePgcr's copy of the rule in
        // src/lib/crawler/pgcr.ts:39-42. Stored rather than recomputed in SQL:
        // a second hand-written copy of the disjunction in the report query
        // would be the one that actually produced the headline number, while the
        // tested copy sat unused. One rule, one place, covered by tests.
        ['is_full_clear', 'INTEGER'],
    ];

    for (const [name, type] of newColumns) {
        if (!existing.has(name)) {
            db.prepare(`ALTER TABLE gos_10k_runs ADD COLUMN ${name} ${type}`).run();
            console.log(`Migrated: added ${name} to gos_10k_runs.`);
        }
    }

    db.exec(`
    CREATE TABLE IF NOT EXISTS gos_10k_pgcr_players (
      instance_id     TEXT NOT NULL,
      character_id    TEXT NOT NULL,
      membership_id   TEXT NOT NULL,
      membership_type INTEGER NOT NULL,
      display_name                    TEXT,
      bungie_global_display_name      TEXT,
      -- Name#Code, in full. Storing the name without the code was a real bug in
      -- this repo; two guardians can share a global display name.
      bungie_global_display_name_code INTEGER,
      character_class TEXT,
      -- Hashes, not names. characterClass is a localized string; the hash is
      -- stable. Resolution to names is a separate, re-runnable manifest script.
      class_hash      INTEGER,
      race_hash       INTEGER,
      gender_hash     INTEGER,
      emblem_hash     INTEGER,
      light_level     INTEGER,
      completed         INTEGER,
      completion_reason INTEGER,
      kills   INTEGER DEFAULT 0,
      deaths  INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      start_seconds       INTEGER DEFAULT 0,
      time_played_seconds INTEGER DEFAULT 0,
      -- From extended.values. No DEFAULT: NULL means "no extended block",
      -- which is a different fact from zero kills.
      precision_kills INTEGER,
      grenade_kills   INTEGER,
      melee_kills     INTEGER,
      super_kills     INTEGER,
      ability_kills   INTEGER,
      -- LOSSY. Bungie serializes fireteamId as a JSON number
      -- (6.607053075707733E+18) so the exact int64 is gone before it reaches us,
      -- and displayValue is a garbage -2147483648. A weak "did these people
      -- queue together" hint only. Never an identity or a join key — the column
      -- name carries the warning because a silently-colliding fireteam_id would
      -- be a far worse bug than no column at all.
      fireteam_id_approx REAL,
      PRIMARY KEY (instance_id, character_id),
      FOREIGN KEY (instance_id) REFERENCES gos_10k_runs(instance_id)
    );

    CREATE INDEX IF NOT EXISTS idx_gos_10k_players_membership
      ON gos_10k_pgcr_players(membership_id);

    CREATE TABLE IF NOT EXISTS gos_10k_pgcr_weapons (
      instance_id     TEXT NOT NULL,
      character_id    TEXT NOT NULL,
      weapon_hash     INTEGER NOT NULL,
      kills           INTEGER DEFAULT 0,
      precision_kills INTEGER DEFAULT 0,
      PRIMARY KEY (instance_id, character_id, weapon_hash),
      -- No ON DELETE CASCADE, deliberately. Nothing here deletes player rows in
      -- normal operation, and if something ever tries, failing loudly is the
      -- right outcome — a cascade would quietly destroy weapon rows during a
      -- rerun, which is the exact class of loss this FK exists to prevent.
      FOREIGN KEY (instance_id, character_id)
        REFERENCES gos_10k_pgcr_players(instance_id, character_id)
    );

    CREATE INDEX IF NOT EXISTS idx_gos_10k_weapons_hash
      ON gos_10k_pgcr_weapons(weapon_hash);

    -- The insurance policy. This crawl is one-shot against a rate-limited API
    -- that may not always exist; ~25 MB gzipped buys the ability to re-derive
    -- every parsed row locally instead of asking Bungie again.
    CREATE TABLE IF NOT EXISTS gos_10k_pgcr_raw (
      instance_id TEXT PRIMARY KEY,
      json_gz     BLOB NOT NULL,
      raw_bytes   INTEGER,
      fetched_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (instance_id) REFERENCES gos_10k_runs(instance_id)
    );
  `);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function buildStatements(db: Database.Database) {
    // UPSERT everywhere, never INSERT OR REPLACE. OR REPLACE is delete-then-
    // insert, so with foreign_keys ON a rerun would transiently orphan the child
    // weapon rows and fail. An explicit ON CONFLICT updates in place, which
    // means correctness no longer rests on statement ordering.
    const upsertRun = db.prepare(`
    UPDATE gos_10k_runs SET
      starting_phase_index = @startingPhaseIndex,
      activity_was_started_from_beginning = @activityWasStartedFromBeginning,
      duration_seconds = @durationSeconds,
      duration_disagreement = @durationDisagreement,
      is_full_clear = @isFullClear,
      -- Confirmed against the PGCR rather than left as the Activity History
      -- value. Same directorActivityHash ?? referenceId fallback the rest of
      -- the repo uses (src/lib/crawler/pgcr.ts:28).
      activity_hash = COALESCE(@activityHash, activity_hash),
      activity_difficulty_tier = @activityDifficultyTier,
      is_private = @isPrivate,
      entry_count = @entryCount,
      player_count = @playerCount,
      pgcr_fetched_at = @fetchedAt,
      pgcr_fetch_status = 'ok'
    WHERE instance_id = @instanceId
  `);

    const markRunFailed = db.prepare(`
    UPDATE gos_10k_runs
       SET pgcr_fetched_at = @fetchedAt, pgcr_fetch_status = @status
     WHERE instance_id = @instanceId
  `);

    const upsertPlayer = db.prepare(`
    INSERT INTO gos_10k_pgcr_players (
      instance_id, character_id, membership_id, membership_type,
      display_name, bungie_global_display_name, bungie_global_display_name_code,
      character_class, class_hash, race_hash, gender_hash, emblem_hash, light_level,
      completed, completion_reason, kills, deaths, assists,
      start_seconds, time_played_seconds,
      precision_kills, grenade_kills, melee_kills, super_kills, ability_kills,
      fireteam_id_approx
    ) VALUES (
      @instanceId, @characterId, @membershipId, @membershipType,
      @displayName, @bungieGlobalDisplayName, @bungieGlobalDisplayNameCode,
      @characterClass, @classHash, @raceHash, @genderHash, @emblemHash, @lightLevel,
      @completed, @completionReason, @kills, @deaths, @assists,
      @startSeconds, @timePlayedSeconds,
      @precisionKills, @grenadeKills, @meleeKills, @superKills, @abilityKills,
      @fireteamIdApprox
    )
    ON CONFLICT(instance_id, character_id) DO UPDATE SET
      membership_id = excluded.membership_id,
      membership_type = excluded.membership_type,
      display_name = excluded.display_name,
      bungie_global_display_name = excluded.bungie_global_display_name,
      bungie_global_display_name_code = excluded.bungie_global_display_name_code,
      character_class = excluded.character_class,
      class_hash = excluded.class_hash,
      race_hash = excluded.race_hash,
      gender_hash = excluded.gender_hash,
      emblem_hash = excluded.emblem_hash,
      light_level = excluded.light_level,
      completed = excluded.completed,
      completion_reason = excluded.completion_reason,
      kills = excluded.kills,
      deaths = excluded.deaths,
      assists = excluded.assists,
      start_seconds = excluded.start_seconds,
      time_played_seconds = excluded.time_played_seconds,
      precision_kills = excluded.precision_kills,
      grenade_kills = excluded.grenade_kills,
      melee_kills = excluded.melee_kills,
      super_kills = excluded.super_kills,
      ability_kills = excluded.ability_kills,
      fireteam_id_approx = excluded.fireteam_id_approx
  `);

    const deleteWeapons = db.prepare(`DELETE FROM gos_10k_pgcr_weapons WHERE instance_id = ?`);

    const upsertWeapon = db.prepare(`
    INSERT INTO gos_10k_pgcr_weapons (instance_id, character_id, weapon_hash, kills, precision_kills)
    VALUES (@instanceId, @characterId, @weaponHash, @kills, @precisionKills)
    ON CONFLICT(instance_id, character_id, weapon_hash) DO UPDATE SET
      kills = excluded.kills,
      precision_kills = excluded.precision_kills
  `);

    const upsertRaw = db.prepare(`
    INSERT INTO gos_10k_pgcr_raw (instance_id, json_gz, raw_bytes, fetched_at)
    VALUES (@instanceId, @jsonGz, @rawBytes, @fetchedAt)
    ON CONFLICT(instance_id) DO UPDATE SET
      json_gz = excluded.json_gz,
      raw_bytes = excluded.raw_bytes,
      fetched_at = excluded.fetched_at
  `);

    return { upsertRun, markRunFailed, upsertPlayer, deleteWeapons, upsertWeapon, upsertRaw };
}

export function storePgcr(
    db: Database.Database,
    statements: ReturnType<typeof buildStatements>,
    parsed: ReturnType<typeof parsePgcr>,
    rawJson: string
): void {
    const fetchedAt = Math.floor(Date.now() / 1000);
    const jsonGz = zlib.gzipSync(rawJson);

    // One transaction per PGCR: the archive can never disagree with the parse,
    // and an interrupted run leaves no half-written instance behind.
    const tx = db.transaction(() => {
        // A rerun could legitimately produce *fewer* weapon rows than before
        // (a corrected parse, say), and an upsert alone would leave the stale
        // ones behind. Delete-then-insert within the transaction, before the
        // player upsert, so the FK is never left dangling.
        statements.deleteWeapons.run(parsed.run.instanceId);

        for (const player of parsed.players) {
            statements.upsertPlayer.run(player);
        }
        for (const weapon of parsed.weapons) {
            statements.upsertWeapon.run(weapon);
        }

        statements.upsertRaw.run({
            instanceId: parsed.run.instanceId,
            jsonGz,
            rawBytes: Buffer.byteLength(rawJson),
            fetchedAt,
        });

        statements.upsertRun.run({
            instanceId: parsed.run.instanceId,
            startingPhaseIndex: parsed.run.startingPhaseIndex,
            activityWasStartedFromBeginning: parsed.run.activityWasStartedFromBeginning,
            durationSeconds: parsed.run.durationSeconds,
            durationDisagreement: parsed.run.durationDisagreement,
            isFullClear: parsed.run.isFullClear ? 1 : 0,
            activityHash: parsed.run.activityHash,
            activityDifficultyTier: parsed.run.activityDifficultyTier,
            isPrivate: parsed.run.isPrivate,
            entryCount: parsed.run.entryCount,
            playerCount: parsed.run.playerCount,
            fetchedAt,
        });
    });

    tx();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function printReport(db: Database.Database, targetMembershipId: string, targetName: string): void {
    console.log('\n===== PGCR backfill report =====');

    const statuses = db
        .prepare(
            `SELECT COALESCE(pgcr_fetch_status, '(not fetched)') AS status, COUNT(*) AS n
         FROM gos_10k_runs GROUP BY 1 ORDER BY n DESC`
        )
        .all() as Array<{ status: string; n: number }>;

    console.log('\nFetch status:');
    for (const row of statuses) {
        console.log(`  ${row.status.padEnd(18)} ${row.n}`);
    }

    const disagreements = db
        .prepare(`SELECT COUNT(*) AS n FROM gos_10k_runs WHERE duration_disagreement = 1`)
        .get() as { n: number };
    console.log(`\nactivityDurationSeconds disagreements across entries: ${disagreements.n}`);
    if (disagreements.n > 0) {
        console.log('  (the "always agrees" assumption does NOT hold — worth investigating)');
    }

    const archive = db
        .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json_gz)), 0) AS gz,
              COALESCE(SUM(raw_bytes), 0) AS raw FROM gos_10k_pgcr_raw`
        )
        .get() as { n: number; gz: number; raw: number };
    console.log(
        `\nRaw archive: ${archive.n} PGCRs, ` +
        `${(archive.gz / 1e6).toFixed(1)} MB gzipped from ${(archive.raw / 1e6).toFixed(1)} MB raw`
    );

    const players = db.prepare(`SELECT COUNT(*) AS n FROM gos_10k_pgcr_players`).get() as { n: number };
    const weapons = db.prepare(`SELECT COUNT(*) AS n FROM gos_10k_pgcr_weapons`).get() as { n: number };
    console.log(`Player rows: ${players.n}   Weapon rows: ${weapons.n}`);

    // The reconciliation against raid.report's 10,000.
    //
    // full_clear comes from the stored is_full_clear column, not from a copy of
    // the disjunction written out again here. Restating it in SQL would make
    // this query — not the tested parse — the thing that decides the headline
    // number, and the two would be free to drift.
    //
    // Restricted to successfully fetched rows: is_full_clear is NULL for
    // anything not yet looked at, and counting those would inflate the
    // full-clear side with rows nobody has checked.
    //
    // Reported as a cross-tab rather than a single number so a mismatch shows
    // *which* predicate moved. If the total is not 10,000, that is a fact about
    // the difference between this definition and raid.report's, not necessarily
    // a bug — do not tune the predicate until it matches.
    const crosstab = db
        .prepare(
            `SELECT
         COALESCE(r.is_full_clear, 0) AS full_clear,
         CASE WHEN EXISTS (
                SELECT 1 FROM gos_10k_pgcr_players p
                 WHERE p.instance_id = r.instance_id
                   AND p.membership_id = @target
                   AND p.completed = 1
              ) THEN 1 ELSE 0 END AS target_completed,
         COUNT(*) AS n
       FROM gos_10k_runs r
      WHERE r.pgcr_fetch_status = 'ok'
      GROUP BY 1, 2
      ORDER BY 1 DESC, 2 DESC`
        )
        .all({ target: targetMembershipId }) as Array<{
            full_clear: number;
            target_completed: number;
            n: number;
        }>;

    console.log(`\nCross-tab over successfully fetched runs (${targetName}):`);
    console.log('  full_clear  target_completed  count');
    for (const row of crosstab) {
        console.log(
            `  ${String(row.full_clear).padEnd(11)} ${String(row.target_completed).padEnd(17)} ${row.n}`
        );
    }

    const both = crosstab.find((r) => r.full_clear === 1 && r.target_completed === 1)?.n ?? 0;
    console.log(`\nFull clears completed by ${targetName}: ${both}`);
    console.log(`raid.report expectation: 10000   difference: ${both - 10000}`);
    if (both !== 10000) {
        console.log(
            '  Not an error. The count and the expectation are two different definitions;\n' +
            '  the cross-tab above shows which side the gap is on.'
        );
    }

    console.log('\n================================\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function backfill(options: Options): Promise<void> {
    const db = new Database(options.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    try {
        const headers = apiHeaders();
        initPgcrSchema(db);
        const statements = buildStatements(db);

        // NULL pgcr_fetched_at is "never attempted"; --retry-failed widens it to
        // everything that did not land cleanly. A previously successful row is
        // never refetched either way — that is what makes an interrupted run
        // free to restart.
        const where = options.retryFailed
            ? `pgcr_fetched_at IS NULL OR pgcr_fetch_status != 'ok'`
            : `pgcr_fetched_at IS NULL`;

        const pending = db
            .prepare(
                `SELECT instance_id FROM gos_10k_runs WHERE ${where} ORDER BY period ASC` +
                (options.limit ? ` LIMIT ${options.limit}` : '')
            )
            .all() as Array<{ instance_id: string }>;

        const total = db.prepare(`SELECT COUNT(*) AS n FROM gos_10k_runs`).get() as { n: number };
        console.log(`${total.n} runs in the database; ${pending.length} to fetch.`);
        if (options.limit) console.log(`(--limit ${options.limit})`);

        let ok = 0;
        let failed = 0;
        let consecutiveFailures = 0;
        let duplicateCharacterEntries = 0;
        let malformedEntries = 0;
        const startedAt = Date.now();

        for (const [index, { instance_id: instanceId }] of pending.entries()) {
            const url = `https://www.bungie.net/Platform/Destiny2/Stats/PostGameCarnageReport/${instanceId}/`;
            const { httpStatus, body } = await fetchRaw(url, headers);
            const outcome = classifyPgcrOutcome(httpStatus, body);

            if (outcome.kind === 'fatal') {
                // Stop rather than record. A maintenance window or a bad key is
                // not a property of this instance, and writing it to the row
                // would turn a five-minute outage into permanent-looking data.
                throw new Error(
                    `Aborting: ${outcome.status} on instance ${instanceId}. ` +
                    `${ok} fetched this run; rerun to resume from here.`
                );
            }

            if (outcome.kind === 'instance') {
                statements.markRunFailed.run({
                    instanceId,
                    fetchedAt: Math.floor(Date.now() / 1000),
                    status: outcome.status,
                });
                failed++;
                consecutiveFailures++;
                if (consecutiveFailures >= CONFIG.consecutiveFailureLimit) {
                    throw new Error(
                        `Aborting: ${consecutiveFailures} consecutive per-instance failures. ` +
                        `That is the API, not the data. Last status: ${outcome.status}.`
                    );
                }
                continue;
            }

            const response = body.Response as RawPgcrResponse;
            const parsed = parsePgcr(response);

            // Every row is keyed by the instance id inside the payload, so if
            // Bungie ever returns a PGCR for a different instance than the one
            // requested, the writes would target a row that does not exist: the
            // UPDATE matches nothing, the player insert violates the FK, and the
            // run reports a success that wrote no data. Checking costs one
            // string compare and turns a silent no-op into a recorded status.
            if (parsed.run.instanceId !== instanceId) {
                statements.markRunFailed.run({
                    instanceId,
                    fetchedAt: Math.floor(Date.now() / 1000),
                    status: 'id-mismatch',
                });
                console.warn(
                    `Instance ${instanceId} returned a PGCR for ${parsed.run.instanceId}; recorded as id-mismatch.`
                );
                failed++;
                // Counts toward the abort circuit like any other failure. A
                // systemic mismatch is exactly the case that must not be allowed
                // to run quietly to completion and report a partial result.
                consecutiveFailures++;
                if (consecutiveFailures >= CONFIG.consecutiveFailureLimit) {
                    throw new Error(
                        `Aborting: ${consecutiveFailures} consecutive failures, last an id-mismatch. ` +
                        `That is the API, not the data.`
                    );
                }
                continue;
            }

            consecutiveFailures = 0;
            duplicateCharacterEntries += parsed.run.duplicateCharacterEntries;
            malformedEntries += parsed.run.malformedEntries;

            // Re-serialize rather than keeping the original bytes: the archive
            // holds Response only, not the constant ErrorCode/Message envelope.
            storePgcr(db, statements, parsed, JSON.stringify(response));
            ok++;

            if ((index + 1) % CONFIG.progressEvery === 0) {
                const elapsed = (Date.now() - startedAt) / 1000;
                const rate = (index + 1) / elapsed;
                const remaining = Math.round((pending.length - index - 1) / rate);
                console.log(
                    `${index + 1}/${pending.length} — ${ok} ok, ${failed} failed, ` +
                    `${rate.toFixed(1)}/s, ~${Math.floor(remaining / 60)}m ${remaining % 60}s left`
                );
            }
        }

        console.log(`\nFetched ${ok} PGCRs, ${failed} failed.`);
        if (duplicateCharacterEntries > 0) {
            // The PK is (instance_id, character_id); a second entry for one
            // character would have been silently dropped. Surfacing it beats
            // discovering the assumption was wrong from a skewed chart later.
            console.log(
                `WARNING: ${duplicateCharacterEntries} duplicate character entries were skipped. ` +
                `Expected 0 — the (instance_id, character_id) key assumes uniqueness.`
            );
        }

        if (malformedEntries > 0) {
            // An entry with no membership id cannot become a row: membership_id
            // is NOT NULL, and inventing a placeholder would put a fake player
            // in the analysis. Skipped and counted instead.
            console.log(
                `WARNING: ${malformedEntries} entries had no membership id and were skipped. Expected 0.`
            );
        }

        printReport(db, CONFIG.targetMembershipId, CONFIG.targetName);
    } finally {
        db.close();
    }
}

// Only run when invoked directly, so the smoke test can import the pieces.
if (require.main === module) {
    backfill(parseArgs(process.argv.slice(2))).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
