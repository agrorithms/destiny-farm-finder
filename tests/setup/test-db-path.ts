import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Points every test file at its own throwaway database directory.
 *
 * This runs as a setupFile, which Vitest executes *before* the test file's own
 * imports. That ordering is the whole point: `DB_PATH` in src/lib/db/index.ts is
 * a module-level const evaluated at import time, so if a test file statically
 * imported anything that pulls in the db module before this ran, the path would
 * resolve against the real data directory. Setting it here means test files can
 * use ordinary static imports instead of `await import()` everywhere.
 *
 * Setting RAID_TRACKER_DB_PATH also relocates DATA_DIR, which derives from its
 * dirname (maintenance/state.ts). That isolates maintenance-state.json too —
 * necessary because getDb() calls isDbQuiesceActive() on every invocation and
 * would otherwise throw DatabaseMaintenanceError for the whole suite if the real
 * database happened to be mid-vacuum.
 *
 * A temp file rather than `:memory:` because SQLite silently downgrades WAL for
 * in-memory databases. See docs/adr/0003.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dff-test-'));

process.env.RAID_TRACKER_DB_PATH = path.join(dir, 'test.db');

// Keep the suite off any real key even if a test reaches code that reads one.
process.env.BUNGIE_API_KEY = 'test-key-not-a-real-credential';

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});
