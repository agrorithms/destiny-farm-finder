# Tests run against a real SQLite file, not `:memory:`

The test suite gives each test file its own throwaway database in a `mkdtemp`
directory, pointed at by `RAID_TRACKER_DB_PATH`, rather than using SQLite's
`:memory:` database. `:memory:` looks like the obvious choice — faster, no
cleanup — so the reason for not using it needs recording.

## Why

SQLite cannot put an in-memory database into WAL mode. `PRAGMA journal_mode = WAL`
returns `memory` for `:memory:` and `wal` for a file, silently:

```
:memory:  journal_mode = WAL  ->  'memory'
file      journal_mode = WAL  ->  'wal'
```

Production runs WAL. The entire justification for testing against a real database
rather than a mock is that it validates the real SQL under real semantics, so
running the suite under a different journal mode gives up most of what the
approach was bought for.

A temp *directory* rather than just a temp file, because `DATA_DIR` in
`src/lib/maintenance/state.ts` derives from `dirname(RAID_TRACKER_DB_PATH)`.
Relocating the database therefore relocates `maintenance-state.json` for free.
That is not incidental: `getDb()` calls `isDbQuiesceActive()` on *every*
invocation, which reads that file from disk — so a suite pointed at the real data
directory would throw `DatabaseMaintenanceError` from every test if it happened
to run while a maintenance vacuum was in progress.

The path is set in a Vitest `setupFile` rather than inside a helper, because
`DB_PATH` is a module-level constant resolved at import time. Setting it before
the test file's own imports run is what lets test files use ordinary static
imports instead of `await import()` throughout.

## Consequences

- Test databases cost a `mkdtemp` plus `initializeSchema()` per test file —
  roughly 5–15 ms on tmpfs. At this suite's size that is a few milliseconds
  overall, well below the value of matching production semantics.
- Temp directories leak into the system temp dir if a test process is killed
  before `afterAll` runs. Harmless, and the OS clears them.
- The schema under test is the production schema by construction: `getDb()` runs
  `initializeSchema()`, including the `ended_at` migration guard and the Phase 3
  indexes. There is no second schema definition that can drift.
