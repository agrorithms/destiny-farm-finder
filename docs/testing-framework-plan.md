# Testing framework — plan of record

**Branch:** `test-framework`
**Date:** 2026-07-26
**Supersedes:** the original `testingframeworksetupplan.md` brief, in the four places noted below.

This is the agreed plan after a recon pass over the repo and a decision-by-decision review. It
exists because the original brief was written against assumptions that the code no longer holds,
and someone reading the resulting commits will otherwise wonder why the phases don't match the
brief they were given.

---

## 1. Where the repo contradicted the brief

The brief instructed: *"Do not guess at any of the above. If something contradicts this document,
trust the repo and tell me."* Four of its seven phases rested on premises that no longer hold.

### 1.1 Phase 5 had nothing left to protect

The brief called the `ended_at` cutover "in-flight" and Phase 5 "the highest-value part of the
task" — a parity net for roughly ten SQL sites still using the `run_durations` CTE.

The cutover already shipped, in `610408e` *"leaderboard denormalization phase 3b — readers
cutover, drop dead indexes"*. There are **zero** `run_durations` references anywhere in `src/`.
The only survivors are inside `scripts/verify-phase3-cutover.ts`, the one-off parity script that
already performed exactly this comparison against the production database.

### 1.2 Phase 3's centerpiece is dead code — and would be wrong if used

The brief identified `processPGCR`'s three-way `||` on `isFullClear` as "the riskiest logic in the
codebase" and devoted 5 of its 11 Phase 3 cases to it.

`ProcessedPGCR.isFullClear` is computed at `src/lib/crawler/pgcr.ts:36`, returned, and **never
read by anything**. `fetchAndStorePGCR` persists `pgcrData.activityWasStartedFromBeginning` — the
raw Bungie field — and every leaderboard filters on that column instead
(`leaderboard-cache.ts:175`, `queries.ts:760/781/820/855`).

That matters more than "unused code," because the local database shows the derivation is also
wrong. Across 827,076 rows:

| Field | Distribution |
|---|---|
| `starting_phase_index` | `0` → 827,076 (**100%**) |
| `activity_was_started_from_beginning` | `0` → 568,648 · `1` → 258,426 |
| `completed` | `0` → 456,009 · `1` → 371,070 |

Bungie now reports `startingPhaseIndex: 0` on every PGCR. Confirmed against live captures in
`tests/fixtures/`, including checkpoint runs where `activityWasStartedFromBeginning` is `false` —
the field is present but no longer discriminates anything. So the `startingPhaseIndex === 0` branch
fires unconditionally and `isFullClear` is `true` for **100%** of runs, including the 568,648 that
are genuinely not full clears. It is inert only because nothing consumes it. Wired
up, it would inflate every leaderboard by roughly 2.2×.

Consequence for fixtures: the brief's requested "checkpoint run (`startingPhaseIndex > 0`)"
fixture **cannot be captured**, because no such row exists in 827k records.

### 1.3 Phase 4 pointed at the wrong file

The leaderboard SQL is `runLeaderboardRows` in `src/lib/cache/leaderboard-cache.ts:146`, not
`src/lib/db/queries.ts`. Two of the brief's bullets don't apply: `fullClearsOnly` is forced `true`
on every code path (there is no `false` branch to test), and the `run_durations` zero-completion
case is obsolete per §1.1.

The real query has edges the brief never mentions — a three-key tie-break
(`completions DESC, lastClearAt ASC, membership_id ASC`), competition-style rank assignment across
tie groups, a `LEFT JOIN players` name fallback, and `formatDisplayName`'s `padStart(4, '0')`.

### 1.4 Phase 6 has no retry logic

The brief asked for "retry/backoff behavior, using Vitest fake timers rather than real sleeps."
`BungieClient.request()` contains no retry — it classifies errors and pauses a shared rate limiter,
then throws. The real fake-timer target is `RateLimiter` (`src/lib/utils/rate-limiter.ts`), a FIFO
promise chain with a subtle mid-sleep `pauseFor` re-read.

Also, `isBungieSystemDisabledError` is two lines (`maintenance.ts:259`), not a subsystem.

### 1.5 What the brief got right

- `getDb()` **is** already injectable, via `RAID_TRACKER_DB_PATH` (`db/index.ts:7`).
- Schema creation **is** programmatic: `initializeSchema()` in `src/lib/db/schema.ts`, invoked by
  `getDb()`. `ended_at` arrives through an `ALTER TABLE` migration guard (`schema.ts:120-123`), so
  a fresh database gets the column and the Phase-3 indexes automatically.
- `/coverage` is already gitignored. `npm run lint` passes clean. Local Node is v22.18.0.
- `processPGCR`'s signature and shape match the brief exactly.

**No application code changes are required by any phase.**

One further correction, outside the brief: raid detection does **not** read
`data/manifest-cache.json` at runtime. `RAID_DEFINITIONS` is a hardcoded literal in
`src/lib/bungie/manifest.ts:16`; the cache file is only *written* by `setup-manifest` for human
review. This makes `isRaidActivityHash` hermetic, which is good for tests, but CLAUDE.md is
misleading on the point.

---

## 2. Decisions

| # | Area | Decision |
|---|---|---|
| 1 | Phase 5 | Retarget to `computeActivityDurationSeconds` — the three-tier duration fallback and the `FUTURE_ENDED_SKEW_SECONDS` corruption guard — asserted end-to-end through `insertFullPGCR`. No parity testing against the removed CTE. |
| 2 | Phase 3 | Test the **persisted** full-clear signal, not `isFullClear`. The dead field is documented for removal in a future change, not removed on this branch. |
| 3 | Fixtures | A committed capture script, seeded with instance IDs pulled from the local database, is run **by the maintainer**. `.env` is never read. |
| 4 | Test DB | `makeTestDb()` uses a per-file `mkdtemp` directory via `RAID_TRACKER_DB_PATH`. See ADR 0003. |
| 5 | Phase 4 | Surviving brief bullets, plus the query's real edges, plus the SQL-vs-JS boundary. |
| 6 | Phase 6 | The predicate, `request()`'s error dispatch behind a stubbed `fetch`, and `RateLimiter` under fake timers. Plus a global guard against unstubbed outbound requests. |
| 7 | CI | `npm ci` · `npm run lint` · `tsc --noEmit` · `npm test`, on Node 22. Typecheck added because nothing else catches type errors without a full `next build`. |
| 8 | Commits | `package-lock.json` isolated in its own commit first, then one scoped commit per phase. Pre-existing untracked files left untouched. |
| 9 | Glossary | Sharpen **Full Clear**; add **Checkpoint Run** and **Completion**. |
| 10 | Records | ADR 0003 (test-database strategy), ADR 0004 (testing policy), and a `docs/decisions.md` entry. |

### Why the test database is a temp file, not `:memory:`

Verified empirically rather than assumed:

```
:memory:  journal_mode = WAL  ->  'memory'   (silently ignored)
file      journal_mode = WAL  ->  'wal'
```

SQLite cannot put an in-memory database into WAL mode, so `:memory:` would exercise different
journal semantics than production — undercutting the entire premise that a real database
"actually validates the SQL." A temp path also isolates `DATA_DIR` for free, because it derives
from `dirname(RAID_TRACKER_DB_PATH)` (`maintenance/state.ts:4-8`). That matters: `getDb()` calls
`isDbQuiesceActive()` on **every** invocation, which reads `data/maintenance-state.json` from
disk — so a suite pointed at the real data directory would fail every test with
`DatabaseMaintenanceError` if run during a maintenance vacuum.

Cost is a `mkdtemp` plus schema init per test file, roughly 5–15 ms on tmpfs. At this suite size
the speed argument for `:memory:` does not survive the numbers.

---

## 3. Execution order

**Phase 1 — install and wire up Vitest.**
`vitest.config.ts`, npm scripts, and the `test-maintenance-cycle` → `e2e:maintenance` rename with
every reference updated.
*Gate: demonstrate a passing run, then a deliberately broken assertion failing with a readable
diff, then delete the throwaway. **Stop and report.***

**Phase 2 — fixtures.**
Commit the capture script. ***Forced pause: the maintainer runs it.*** Then the builders in
`tests/helpers/` and `tests/fixtures/README.md`.

**Phases 3 → 7 — run straight through**, one scoped commit each, then the docs commit.

Two mandatory stops: the Phase 1 gate, and the fixture capture.

---

## 4. Out of scope

No React, DOM, or jsdom testing. No Playwright. No coverage thresholds or gates — the reporter is
installed, no number is enforced. No mocking of our own modules; the network boundary only. No
tests against the real database file or the real Bungie API. `scripts/test-maintenance-cycle.ts`
is not ported, rewritten, or absorbed — it changes only by script name. No cutover is performed.
The `isFullClear` defect is reported, not fixed.

---

## 5. Findings to report, not fix

1. **`ProcessedPGCR.isFullClear` is dead and would be wrong if used.** See §1.2. Flagged for
   removal in a future change.
2. **`formatDisplayName` drops the `#code` when the code is falsy**
   (`leaderboard-cache.ts:135`), contradicting the `Name#Code` invariant CLAUDE.md calls
   load-bearing.
3. **`getDb()` reads `maintenance-state.json` from disk on every call**, not just on open.
4. **CLAUDE.md's raid-detection description is inaccurate** — see the note at the end of §1.5.
5. **55% of stored PGCRs (456,009 of 827,076) have zero completed players.** Not a defect on its
   own, but it is the dominant shape in the table and worth knowing when reasoning about any
   query that joins through completions.
