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

// The only databases this process is allowed to open. Each connection compares its
// own resolved path against its own sentinel and refuses anything else while VITEST
// is set, so if the ordering described above is ever broken the suite fails loudly
// instead of quietly operating on the real, live data. Set here rather than in a
// helper because this file is the only thing that knows which directory was minted.
process.env.DFF_TEST_DB_SENTINEL = path.join(dir, 'test.db');

// The same treatment for the second database this app opens, the GoS 10k Archive.
// Same directory, same mkdtemp, so there is one thing to break rather than two. The
// file itself is only created by tests that ask for it — tests/helpers/archive-seed.ts
// builds it from the committed JSON seed — and getArchiveDb() refuses to create one,
// so a test that reaches the Archive without seeding it fails loudly rather than
// reading an empty database. See docs/adr/0003's 2026-09-04 amendment and ADR 0007.
process.env.GOS10K_ARCHIVE_DB_PATH = path.join(dir, 'gos-10k-test.db');
process.env.DFF_TEST_GOS10K_DB_SENTINEL = path.join(dir, 'gos-10k-test.db');

// Keep the suite off any real key even if a test reaches code that reads one.
process.env.BUNGIE_API_KEY = 'test-key-not-a-real-credential';

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});
