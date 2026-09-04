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

That ordering is load-bearing, and breaking it fails *silently*: `DB_PATH` resolves
to the real data directory, and the suite's `DELETE FROM` and `VACUUM` paths operate
on live data without erroring. So `getDb()` refuses to open anything but the
throwaway path while `VITEST` is set — `tests/setup/test-db-path.ts` publishes the
directory it minted as `DFF_TEST_DB_SENTINEL`, and `assertDbPathAllowed()` in
`src/lib/db/index.ts` requires an exact match. Keyed on `VITEST` rather than on the
sentinel alone so that a suite where the setup file never ran at all — the case where
every other protection has already failed — still refuses rather than going quiet.

The tempting alternative was to remove the hazard instead of detecting it: have the
setup file `await import('@/lib/db')` immediately after setting the env var, pinning
`DB_PATH` before anything else can. Rejected because its correctness depends on the
import being *dynamic* — a static `import` hoists above the assignment and does
nothing — so a routine tidy-up reverts it, silently, which is the property that made
the original hazard dangerous in the first place.

## Amendment (2026-08-03): the same approach, extended to the Playwright suite

The browser suite (`e2e/`) uses the same mechanism — `mkdtemp`, one throwaway
database per run, pointed at by `RAID_TRACKER_DB_PATH` — and seeds it through the
same `tests/helpers/` that Vitest uses, so both runners agree on what a seeded
raid run is.

Two things had to change.

**The guard now fires under `DFF_E2E` as well as `VITEST`.** Keying it on `VITEST`
alone left it completely inert under Playwright, which is the environment that
needs it *more*: two processes must receive the fixture path — the seeding process
and the `next start` child — where Vitest has one.

**A guard that is opt-in by env cannot fire if the env never arrives.** That is the
gap `VITEST` did not have, because Vitest sets `VITEST` itself. Two further layers
close it:

1. `playwright.config.ts` throws at config load if `mintFixtureDbPath()` did not
   set every expected variable. It is the sole entry point and the thing that
   builds `webServer.env`, so nothing else can forget.
2. `e2e/support/canary.setup.ts` seeds a row whose name carries a per-run nonce and
   asks the *running server* for it through `/api/players/search` before any spec
   executes. This is the only layer that observes which database the server
   actually opened rather than reasoning about configuration. The nonce is what
   makes it work: a server left over from an earlier run holds that run's canary,
   so without it the check would pass while every spec read a stale database.
   `reuseExistingServer: false` avoids that case rather than merely detecting it.

`tests/setup/test-db-path.ts` could not be reused — it imports `afterAll` from
`vitest` — so `e2e/support/fixture-db.ts` mints the path instead, using the same
technique. It is idempotent because `playwright.config.ts` is re-loaded in every
worker process, and a second mint would create a directory nothing else knows
about.

## Amendment (2026-09-04): the guard covers every database this app opens

The arrival of the Archive (`data/gos-10k.db`, ADR 0007) made the wording above read as if it were
about *the* database. It never was — it is about not letting a test process touch anything that
isn't throwaway — so `assertDbPathAllowed()` was generalised to take
`(dbPath, sentinelEnvVar, label)` and both connections call it. `tests/setup/test-db-path.ts` mints
`DFF_TEST_GOS10K_DB_SENTINEL` alongside `DFF_TEST_DB_SENTINEL`, in the same directory.

The alternative was to document that the guard covers the Tracker only, and that `readonly: true`
on the Archive makes the gap acceptable. That is true today and it is still the wrong shape: a hole
maintained by a comment, which survives exactly as long as the next person reads the comment.
Generalising cost about twenty lines and leaves none.

`readonly` is not the belt-and-braces it looks like, either. It stops a test *writing* the real
Archive; it does nothing about a test asserting against 13,420 production rows and passing for the
wrong reason.

**The fixture Archive is a real built file, like every other test database here.** It is not a
committed binary: `tests/fixtures/archive-seed.json` is extracted from the master by
`scripts/extract-archive-fixture.ts` and loaded into a fresh SQLite file at test-setup time. That
keeps it consistent with the nine existing JSON fixtures — reviewable in a diff — while still
testing real SQL against a real file. The rows are sampled from genuine data, including the
hazards: a run with `is_full_clear = 1` that the subject did not complete, a duplicate-character
run, a NULL name code, and runs either side of the 2022-02-21 pin. A hand-written seed would encode
our beliefs; the hazards are the whole reason the fixture exists.

The loader lives in `tests/helpers/`, so per `CLAUDE.md` it imports nothing from `vitest` and uses
relative imports only — Playwright's loader does not apply tsconfig `paths` to `globalSetup`.

## Consequences

- Test databases cost a `mkdtemp` plus `initializeSchema()` per test file —
  roughly 5–15 ms on tmpfs. At this suite's size that is a few milliseconds
  overall, well below the value of matching production semantics.
- Temp directories leak into the system temp dir if a test process is killed
  before `afterAll` runs. Harmless, and the OS clears them. The e2e run leaves its
  directory in place deliberately and prints the path, because the first question
  after a browser-test failure is what was actually in the database.
- A misconfigured suite fails on the first `getDb()` call with `Refusing to open …`
  rather than quietly using the real database. `tests/setup/test-db-path.test.ts`
  pins the invariant, including that `VITEST` is actually set — an inert guard is
  the only failure mode here that hides, since one that wrongly refuses breaks
  every test file at once.
- Both sentinels are minted by the same setup file and point into the same `mkdtemp` directory, so
  there is one thing to break rather than two. A connection added later without a sentinel of its
  own is the failure this amendment does not prevent; adding one is three lines.
- `openMaintenanceDb()` is deliberately *not* guarded: nothing in the suite reaches
  it today. Its callers (`src/lib/bungie/maintenance.ts`) `VACUUM` through it, so a
  test that exercises them should add the check.
- The schema under test is the production schema by construction: `getDb()` runs
  `initializeSchema()`, including the `ended_at` migration guard and the Phase 3
  indexes. There is no second schema definition that can drift.
