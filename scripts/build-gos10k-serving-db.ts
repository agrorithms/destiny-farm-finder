import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

/**
 * Builds the GoS 10k Archive serving copy from the collection master.
 *
 * Three distinct files, and the distinction is the whole point:
 *
 *   gos10k/destiny_pgcrs.db                     the master   — gitignored, the input
 *   data/gos-10k.db                             the serving copy — gitignored, the output
 *   src/lib/db/archive/gos-10k-manifest.json    the manifest — COMMITTED
 *
 * Git holds the transformation and the manifest, never the data. That is what makes a
 * ~71 MB production artifact reproducible and reviewable without 71 MB entering the repo,
 * and it is why the manifest must live in the source tree rather than beside the database:
 * a manifest that travels with the file it describes cannot detect a stale copy, because a
 * stale copy brings its own matching manifest.
 *
 * What the serving copy drops: `gos_10k_pgcr_raw`, ~48 MB of stored PGCR JSON whose entire
 * purpose is re-parsing locally without touching Bungie. It has no function in production.
 * Weapons are kept deliberately — see ADR 0007.
 *
 *   npm run build-gos10k
 *
 * Re-run this after any change to the master, then re-scp both files (docs/decisions.md).
 * getArchiveDb() verifies the row counts below on first open and throws if they disagree.
 */

const MASTER_PATH = process.env.GOS10K_MASTER_DB_PATH
    ? path.resolve(process.env.GOS10K_MASTER_DB_PATH)
    : path.join(process.cwd(), 'gos10k', 'destiny_pgcrs.db');

const OUTPUT_PATH = process.env.GOS10K_ARCHIVE_DB_PATH
    ? path.resolve(process.env.GOS10K_ARCHIVE_DB_PATH)
    : path.join(process.cwd(), 'data', 'gos-10k.db');

const MANIFEST_PATH = path.join(process.cwd(), 'src', 'lib', 'db', 'archive', 'gos-10k-manifest.json');

/** Dropped from the serving copy. Local replay archive; no production function. */
const DROPPED_TABLES = ['gos_10k_pgcr_raw'];

/** The tables whose counts getArchiveDb() checks at open. */
const VERIFIED_TABLES = ['gos_10k_runs', 'gos_10k_pgcr_players', 'gos_10k_pgcr_weapons'];

function sha256(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function countRows(db: Database.Database, tables: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const table of tables) {
        // Table names are the literals above, never input.
        counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return counts;
}

function mb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main(): void {
    if (!fs.existsSync(MASTER_PATH)) {
        throw new Error(
            `No master at ${MASTER_PATH}. This script needs the collection master, which is ` +
            `gitignored and lives only where the crawl was run. Set GOS10K_MASTER_DB_PATH to ` +
            `point elsewhere.`
        );
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

    // Two vacuums rather than one, because the master must not be written to and
    // DROP TABLE is a write. The first produces a scratch copy we are free to modify;
    // the second reclaims the dropped pages into the file that actually ships.
    const scratchPath = `${OUTPUT_PATH}.building`;
    for (const stale of [scratchPath, OUTPUT_PATH]) {
        if (fs.existsSync(stale)) fs.rmSync(stale);
    }

    console.log(`📖 master   ${MASTER_PATH} (${mb(fs.statSync(MASTER_PATH).size)})`);

    const master = new Database(MASTER_PATH, { readonly: true, fileMustExist: true });
    const masterCounts = countRows(master, [...VERIFIED_TABLES, ...DROPPED_TABLES]);
    master.prepare('VACUUM INTO ?').run(scratchPath);
    master.close();

    const scratch = new Database(scratchPath);
    for (const table of DROPPED_TABLES) {
        scratch.exec(`DROP TABLE IF EXISTS ${table}`);
        console.log(`🗑️  dropped  ${table} (${masterCounts[table]?.toLocaleString() ?? 0} rows)`);
    }
    scratch.prepare('VACUUM INTO ?').run(OUTPUT_PATH);
    scratch.close();
    fs.rmSync(scratchPath);

    // Count off the *output*, not the scratch copy, so the manifest describes the file
    // that ships rather than the one we believe it was made from.
    const serving = new Database(OUTPUT_PATH, { readonly: true, fileMustExist: true });
    const rowCounts = countRows(serving, VERIFIED_TABLES);
    serving.close();

    for (const table of VERIFIED_TABLES) {
        if (rowCounts[table] !== masterCounts[table]) {
            throw new Error(
                `${table}: master has ${masterCounts[table]} rows, serving copy has ` +
                `${rowCounts[table]}. The vacuum lost data; refusing to write a manifest.`
            );
        }
    }

    const manifest = {
        database: 'gos-10k',
        builtAt: new Date().toISOString(),
        builtBy: 'scripts/build-gos10k-serving-db.ts',
        master: {
            path: path.relative(process.cwd(), MASTER_PATH),
            sha256: sha256(MASTER_PATH),
            bytes: fs.statSync(MASTER_PATH).size,
        },
        serving: {
            sha256: sha256(OUTPUT_PATH),
            bytes: fs.statSync(OUTPUT_PATH).size,
        },
        droppedTables: DROPPED_TABLES,
        rowCounts,
    };

    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`);

    console.log(`💾 serving  ${OUTPUT_PATH} (${mb(manifest.serving.bytes)})`);
    for (const table of VERIFIED_TABLES) {
        console.log(`   ${table.padEnd(24)} ${rowCounts[table].toLocaleString().padStart(9)}`);
    }
    console.log(`📝 manifest ${path.relative(process.cwd(), MANIFEST_PATH)} — commit it.`);
    console.log('👉 Next: scp both databases to the box, then pm2 restart web. See docs/decisions.md.');
}

main();
