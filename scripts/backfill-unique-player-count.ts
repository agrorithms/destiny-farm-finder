/**
 * Backfill `pgcrs.unique_player_count` — the count of distinct membership IDs
 * per PGCR, derived from the `pgcr_players` table's `(instance_id, membership_id)`
 * primary key. `COUNT(*)` per instance gives the correct value because INSERT OR
 * IGNORE already deduplicates by membership ID.
 *
 * Batched and yielding so it can run alongside the crawler without holding the
 * SQLite write lock for extended periods. Follows the deleteExpiredPGCRBatch
 * pattern: small transactions with async yields in between.
 *
 *   npx tsx scripts/backfill-unique-player-count.ts
 *
 * Env knobs:
 *   BACKFILL_UPC_BATCH_SIZE  — rows per transaction (default 500)
 *   BACKFILL_UPC_YIELD_MS    — pause between batches (default 25)
 */
import 'dotenv/config';
import { openMaintenanceDb, DB_PATH } from '../src/lib/db';
import { initializeSchema } from '../src/lib/db/schema';

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_YIELD_MS = 25;

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function log(message: string): void {
    console.log(`[backfill-unique-player-count] ${message}`);
}

function fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0
        ? `${m}m${String(s % 60).padStart(2, '0')}s`
        : `${s}s`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const batchSize = envInt('BACKFILL_UPC_BATCH_SIZE', DEFAULT_BATCH_SIZE);
    const yieldMs = envInt('BACKFILL_UPC_YIELD_MS', DEFAULT_YIELD_MS);

    const db = openMaintenanceDb();
    try {
        initializeSchema(db);

        const cols = db.prepare('PRAGMA table_info(pgcrs)').all() as { name: string }[];
        if (!cols.some((c) => c.name === 'unique_player_count')) {
            throw new Error('pgcrs.unique_player_count column not found — run schema migration first.');
        }

        const totalNull = (db.prepare(
            `SELECT COUNT(*) AS n FROM pgcrs WHERE unique_player_count IS NULL`
        ).get() as { n: number }).n;

        if (totalNull === 0) {
            log('No rows to backfill — all PGCRs already have unique_player_count.');
            return;
        }

        log(`DB: ${DB_PATH}`);
        log(`Rows to backfill: ${totalNull.toLocaleString()}`);
        log(`Batch size: ${batchSize}, yield: ${yieldMs}ms`);

        const update = db.prepare(`
            UPDATE pgcrs
            SET unique_player_count = (
                SELECT COUNT(*) FROM pgcr_players
                WHERE pgcr_players.instance_id = pgcrs.instance_id
            )
            WHERE rowid IN (
                SELECT rowid FROM pgcrs
                WHERE unique_player_count IS NULL
                LIMIT ?
            )
        `);

        const t0 = Date.now();
        let updated = 0;
        let batches = 0;

        while (true) {
            const result = update.run(batchSize);
            updated += result.changes;
            batches += 1;

            if (result.changes === 0) break;

            if (batches % 100 === 0) {
                const elapsed = Date.now() - t0;
                const pct = totalNull > 0 ? (updated / totalNull) * 100 : 100;
                const eta = pct > 0 ? (elapsed / pct) * (100 - pct) : 0;
                log(
                    `  ${pct.toFixed(1)}% | updated ${updated.toLocaleString()}/${totalNull.toLocaleString()} | ` +
                    `elapsed ${fmtDuration(elapsed)} | ETA ${fmtDuration(eta)}`
                );
            }

            await sleep(yieldMs);
        }

        const elapsed = Date.now() - t0;
        log(`Backfill complete: updated ${updated.toLocaleString()} rows in ${batches} batches (${fmtDuration(elapsed)})`);

        const stillNull = (db.prepare(
            `SELECT COUNT(*) AS n FROM pgcrs WHERE unique_player_count IS NULL`
        ).get() as { n: number }).n;
        log(`Remaining NULL: ${stillNull.toLocaleString()}`);
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
