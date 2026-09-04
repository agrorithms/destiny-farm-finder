# Decisions

Running log of decisions that aren't big enough for an ADR, or that live partly outside the
codebase (infrastructure, Cloudflare config) where a code comment can't reach them.

---

## 2026-07-26 — HTTP caching for the real-time API routes

### Symptom

After deploying the fireteam-denominated display cap (`f760d58`), the browser stopped showing
live numbers:

- `/api/live-stats` and `/api/active-sessions?limit=600` both served as `200 OK (from disk cache)`.
- The StatsBar's full-clear count and active-fireteam count sat unchanged for roughly an hour.
- `/api/active-sessions?limit=600` fired **twice** per poll — one from disk cache, one a real
  200 or 304.

### The display-cap change was not the cause

Confirmed, not assumed:

```
git show f760d58 -- src/app/api/active-sessions/route.ts \
                    src/app/api/live-stats/route.ts \
                    src/lib/http/cache.ts
  | grep -E '^[-+].*(withCache|withNoStore|Cache|max-age|dynamic)'
→ no matches
```

`src/lib/http/cache.ts` had not been touched since 2026-05-29 (`51414df`). The
`withCache(…, 10, 30)` on active-sessions and `withCache(…, 15, 30)` on live-stats predate that
work by two months. The change altered *which* numbers those endpoints return, never how they are
cached.

The origin was also verified healthy — three cache-busted fetches 18s apart returned 408, 412 and
411 fireteams with an advancing `timestamp`. Nothing was frozen server-side.

### Root cause

`cacheControl()` emits `public, max-age=0, s-maxage=N, stale-while-revalidate=M`. Nothing in the
repo has ever emitted a non-zero `max-age`. The value reaching the browser was being rewritten by
Cloudflare, and the three endpoints differed in a way that pinned it exactly:

| endpoint | Cloudflare cache rule | `max-age` at the browser | `cf-cache-status` |
|---|---|---|---|
| `/api/status` | none | `0` — origin value, untouched | `DYNAMIC` |
| `/api/active-sessions` | Browser TTL: override, 1s | `1` | `HIT` / `EXPIRED` |
| `/api/live-stats` | Browser TTL: **unset** | `14400` | `HIT` / `EXPIRED` |

Leaving Browser TTL unset in a cache rule does **not** pass the origin header through. It falls
back to the zone-level Browser Cache TTL (Caching → Configuration), whose default is 4 hours —
hence `max-age=14400`, hence a browser entitled to serve the stat bar from disk for four hours
without asking. `/api/status`, which has no cache rule and is therefore not eligible for cache,
proves the contrast: its `max-age=0` arrives unmodified.

### Decision: fix it at Cloudflare, not at the origin

~15s of caching is wanted, not merely tolerated — it shields the SQLite dedupe pass from repeated
polling across two PM2 workers. Cloudflare is the correct layer to express "cache 15s at the edge,
never in the browser", because it can separate edge TTL from browser TTL. The origin header cannot.

**Applied:** Browser TTL → *override origin, 1 second* on the `/api/live-stats` cache rule,
mirroring the rule already on `/api/active-sessions`. Verified afterwards:

```
/api/live-stats     cache-control: public, max-age=1, s-maxage=15, stale-while-revalidate=30
/api/active-sessions  cache-control: public, max-age=1, s-maxage=10, stale-while-revalidate=30
```

The four-hour freeze is gone.

### Trap: do not "fix" this with `withNoStore`

The obvious-looking origin fix — switching both routes to `withNoStore` — was written, tested
against this analysis, and **reverted deliberately**. The `/api/live-stats` rule uses Edge TTL
*"use cache-control header if present, bypass cache if not"*. A `no-store` response makes
Cloudflare **bypass the edge cache entirely**, destroying the 15s edge caching the rule exists to
provide. The origin header and the cache rule have to be designed together; changing one in
isolation fights the other.

`export const dynamic = 'force-dynamic'` was reverted for a different reason: it was never the
problem. Next.js 15+ does not cache GET route handlers by default, and prod was measurably dynamic
already. Harmless, but it would have been misleading documentation of a cause that wasn't real.

### Still outstanding: the double fetch

Cloudflare's Browser TTL override rewrites `max-age` but passes `stale-while-revalidate` through
untouched:

```
cache-control: public, max-age=1, s-maxage=10, stale-while-revalidate=30
                       ^^^^^^^^^ Cloudflare      ^^^^^^^^^^^^^^^^^^^^^^ origin, unmodified
```

Chrome implements SWR. Past `max-age=1` the copy is stale, so each 30s poll hands the page the
stale disk copy *immediately* and fires a background revalidation — the two network rows, and data
rendered up to ~31s old. This is the origin's `stale-while-revalidate=30` doing exactly what it
says; the directive is simply wrong for an endpoint that is polled on a fixed interval.

**Recommended origin change (not yet made):** keep `withCache`, drop the
`stale-while-revalidate` term for the two real-time endpoints. Resulting behaviour:

- Browser: `max-age` pinned to 1s by the cache rule, no SWR → every poll is a real conditional
  request. One network row.
- Cloudflare edge: absorbs those polls at its configured TTL, one origin query per ~15s.
- Origin: unchanged cost.

Open question before doing it: whether to drop SWR globally from `cacheControl()` or only for
these two. SWR is defensible on the slower-moving endpoints, so a second helper
(`withCacheNoStale`, or an optional third argument) is probably better than changing the shared
one.

### Latent exposure elsewhere

These still send `public` to the browser and would freeze the same way if a cache rule without a
Browser TTL were ever added for them:

- `src/app/api/leaderboard/route.ts:41`
- `src/app/api/players/[membershipType]/[membershipId]/route.ts:176`
- `src/app/api/raids/route.ts:14`
- `src/app/api/status/route.ts:36` (healthy path only)

Slower-moving data, so a stale read is less visible — but a player page stuck for four hours is the
same failure. **Durable mitigation:** set the zone-level Browser Cache TTL to *Respect Existing
Headers*. While it stays at the 4-hour default, every future cache rule written without an explicit
Browser TTL inherits this bug.

### Consequences

- Cloudflare cache rules are load-bearing configuration for this app, and they are not in the repo.
  A rule added or edited without a Browser TTL reintroduces a multi-hour client-side freeze that
  looks exactly like an origin bug and cannot be reproduced locally.
- When a "stale data" report arrives, check `cf-cache-status` and the `cache-control` actually
  received before reading any application code. `curl -sS -D - -o /dev/null <url>` against prod
  settles origin-vs-edge-vs-browser in one request; a cache-busted fetch confirms the origin
  independently.
- `s-maxage` in `cacheControl()` is only honoured where a cache rule makes the path eligible.
  Endpoints with no rule (`/api/status`) are `DYNAMIC` and their `s-maxage` is inert.

---

## 2026-07-26 — Testing framework: what got built, and what the brief got wrong

The repo had no unit test framework. Vitest is now wired up with tests covering `processPGCR`,
the leaderboard query, `ended_at` derivation, Bungie error handling, and the rate limiter. Full
plan of record: `docs/handoffs/testing-framework-handoff.md`. Strategy decisions: ADR 0003 (real SQLite files,
not `:memory:`) and ADR 0004 (mock only at the network boundary).

Recorded here are the findings that changed the shape of the work, and the defects found along the
way that were **not** fixed.

### `ProcessedPGCR.isFullClear` was dead code, and would have been wrong if used

`src/lib/crawler/pgcr.ts` derived `isFullClear` from a three-way `||`. Nothing read it.
`fetchAndStorePGCR` persists Bungie's raw `activityWasStartedFromBeginning`, and every leaderboard
filters on that column — since issue #70, through the `FULL_CLEAR` and `COMPLETION` constants in
`queries.ts` rather than a dozen inline copies.

It was also incorrect, for the reason recorded below under `startingPhaseIndex` is sent, and is
always `0`: Bungie reports it as `0` on every PGCR — verified against live API captures,
including confirmed checkpoint runs where `activityWasStartedFromBeginning` is
`false`. The field is present but inert, so the `startingPhaseIndex === 0` branch fired
unconditionally and `isFullClear` was `true` for 100% of runs. Of those, 568,648 have
`activity_was_started_from_beginning = 0`, i.e. they are checkpoint runs. Wiring this field into
the writer would inflate every full-clear leaderboard by roughly 2.2×.

**Action taken:** the field was deleted as part of issue #70 (consolidating the full-clear
predicates). It was deliberately left untested — pinning dead behaviour would only have made
removal harder. This section stays because the 2.2× finding is why the guarding tests in
`tests/db/full-clear-flag.test.ts` exist: they pin the *writer* against ever adopting a derivation
like it.

### `formatDisplayName` drops the `#Code` when the code is zero

`src/lib/cache/leaderboard-cache.ts:135` guards with
`if (entry.bungieGlobalDisplayName && entry.bungieGlobalDisplayNameCode)`. A code of `0` is falsy,
so the branch is skipped and the player renders as a bare name. CLAUDE.md calls the full
`Name#Code` form load-bearing and notes partial names were a real bug before.

Pinned as current behaviour in `tests/db/leaderboard.test.ts`, labelled `BUG:` — not endorsed. Not
fixed here because the brief said to report defects rather than fix them, and because whether a
`#0000` code is reachable in Bungie's namespace was not established.

### `getDb()` hits the filesystem on every call

`isDbQuiesceActive()` reads `data/maintenance-state.json` from disk on **every** `getDb()`
invocation, not just on open. Not a correctness bug — but it is why test isolation has to relocate
`DATA_DIR` and not merely the database file, since a suite running during a maintenance vacuum
would otherwise fail every test with `DatabaseMaintenanceError`.

### CLAUDE.md's raid-detection description is inaccurate — fixed 2026-07-29

CLAUDE.md states raid detection "matches `activityHash` against the manifest cache
(`data/manifest-cache.json`)". Nothing reads that file. `RAID_DEFINITIONS` is a hardcoded literal
in `src/lib/bungie/manifest.ts:16`; `setup-manifest` only *writes* the cache, for human review
before hand-editing the literal. Convenient for tests — raid detection is fully hermetic — but the
documentation implies a runtime dependency that does not exist.

Corrected in CLAUDE.md on 2026-07-29. The same-day CLAUDE.md trim then removed the redundant
"Raid Detection" section and the code-layout line entirely, so the single conventions bullet is
now the only statement of it: the table is static source, and `setup-manifest` alone changes
nothing about detection.

### The `ended_at` cutover was already complete

The brief described it as in-flight and asked for a parity safety net across ~10 SQL sites. It
shipped in `610408e`; zero `run_durations` references remain in `src/`. That phase was retargeted
to testing `computeActivityDurationSeconds` — the tiered derivation that replaced the CTE — which
is where a wrong row set would now come from.

### Zero-completion runs are the dominant shape

456,009 of 827,076 stored PGCRs (55%) have no player with `completed = 1`. Not a defect, but worth
knowing before reasoning about any query that joins through completions: the "no completions" case
is the common path, not an edge case.

### Addendum, same day — what capturing real fixtures corrected

Three claims above were inferred from the database and turned out to be wrong at the source. The
conclusions held; the mechanisms did not.

**`startingPhaseIndex` is sent, and is always `0`.** Not absent, as first written. It is present on
every captured PGCR including three confirmed checkpoint runs
(`activityWasStartedFromBeginning: false`). The database showed `0` everywhere because the writer
coerces with `|| 0`, which had flattened the evidence. So `isFullClear`'s `=== 0` branch fires
rather than its `=== undefined` branch — the field is still `true` for 100% of runs, so nothing
about the defect changes.

**A player can appear several times in one report.** `pgcr-multi-character-garden.json` has six
entries belonging to **two** people, three characters each. `pgcr_players` is keyed
`(instance_id, membership_id)` with `INSERT OR IGNORE`, so only each player's *first* entry is
stored: that player's `time_played_seconds` records 981s when their longest character played 1494s.
`kills`, `deaths`, `assists` and `time_played_seconds` are written but **read nowhere in `src/`**,
so this is latent rather than user-visible. Duration derivation is unaffected — it runs on the
in-memory entries before the dedupe.

**Bungie can withhold identity entirely.** `pgcr-missing-bungie-name.json` has nineteen entries,
every one arriving as `isPublic: false`, `membershipType: 0`, with **no `displayName` and no
`bungieGlobalDisplayName`**. This is not "the global name is missing so fall back to the platform
name" — there is no fallback left, and `formatDisplayName` ends up rendering a raw membership id.
Ingestion handles it correctly: all nineteen rows store with NULL names rather than being rejected,
which is right, since the run itself is real.

Note also that `types.ts` declares `UserInfoCard.displayName` and
`DestinyPostGameCarnageReportData.startingPhaseIndex` as required, and both are optional in
practice. The type is more confident than the API.

## 2026-07-29 — Guarding the test suite against opening the real database

`DB_PATH` (`src/lib/db/index.ts:7`) is a module-level const resolved at import time, so the test
suite lands on its throwaway database only because `tests/setup/test-db-path.ts` runs as the first
`setupFile`. Break that ordering and the failure is *silent*: `DB_PATH` becomes the real path and
`resetTestDb()`'s five `DELETE FROM`s, plus every seeded write, hit live data without erroring.

The tell was an asymmetry. The suite guards the *network* with a real thrower
(`tests/setup/no-network.ts`) and guarded the *database* with nothing but import ordering and a
comment.

**Decision.** `assertDbPathAllowed()` in `getDb()`: while `VITEST` is set, `DFF_TEST_DB_SENTINEL`
(published by the setup file) must exist and match `DB_PATH` exactly, or the call throws. Recorded
against ADR 0003, whose mechanism this hardens, with a line in ADR 0004 stating that a configuration
guard is not a mock — deliberately, so nobody deletes the `VITEST` branch as a smell.

### Scope, and what was rejected

- **`getDb()` only.** `openMaintenanceDb()` opens a second raw connection and its callers `VACUUM`
  through it, but nothing in the suite reaches it; left unguarded with a comment saying so.
- **Not the eager-import fix.** Having the setup file `await import('@/lib/db')` to pin `DB_PATH`
  removes the hazard rather than detecting it and needs no `src/` change — but it only works as a
  *dynamic* import, since a static one hoists above the env assignment. A routine tidy-up reverts it
  silently, which is exactly what made the original hazard dangerous.
- **Not sentinel-only keying.** Reads as a general invariant and keeps `src/` innocent of tests, but
  goes inert when the sentinel is unset — i.e. when the setup file never ran, the case where
  everything else has already failed.
- **Not a guard in `tests/helpers/db.ts`.** `tests/helpers/seed.ts` and
  `tests/db/ended-at-derivation.test.ts` import `getDb` directly, so a helper-level check would have
  covered the deletes and left the writes open: a partial guard that reads as complete.
- **Not a new ADR.** Cheap to reverse (six deletable lines), so two of the three ADR criteria fail.

### Blast radius, for the record

Smaller than it first looks, and it sizes the whole decision. Tests run on dev, where `DB_PATH`
defaults to the 2.5 GB `data/raid-tracker.db` with a live crawler attached. Production is a separate
host that never runs `npm test`; CI has no database at all. Worst case was "wipe the dev DB,
re-crawl", cushioned by the dated snapshots in `data/`. Cheap insurance against an annoying loss,
not disaster prevention.

Verified by running `getDb()` under `tsx` with `VITEST=true` across four cases — sentinel missing,
sentinel mismatched, sentinel matching, and `VITEST` unset — each against a scratch path so a broken
guard could not touch the real database. First two throw, last two proceed.

---

## 2026-07-31 — Enforcement hooks for environment debris (`.claude/hooks/`)

Not an ADR. Checked against ADRs 0001–0005 first, per standing preference: this contradicts and
hardens none of them. All five are application/data-behaviour decisions — display caps, session
counts, test isolation, network mocking, loop resilience — and none touches tooling. This file's
own header covers decisions that "live partly outside the codebase … where a code comment can't
reach them", which describes `.claude/` exactly.

### Why hooks rather than more documentation

A usage-insights report over 24 sessions produced one finding worth acting on: **process problems
were being fixed with documentation instead of automation.** The repo already had a `verify` skill,
five ADRs, this file, and an unusually thorough CLAUDE.md — and zero hooks.

That matters because the two friction categories are of different kinds:

- **Documentation is advisory.** It works only if the model reads and honours it. Fine for domain
  conventions (`player identity is Name#Code`) where the model has no competing instinct.
- **Hooks are enforcement.** They run whether or not the model remembers, and can refuse a tool
  call outright.

The environment-debris friction is the second kind, and had recurred for five weeks *despite being
well understood* — because its failures surface after the session ends, when no instruction is in
context. An orphaned `next dev` holding port 3000 blocks the user's own `npm run dev` days later.
Concurrent `next build` runs collide on the build lock, which requires knowing about a process
started in a different tool call. `npm uninstall sqlite3` when only the `package.json` entry was
wanted needs a *stop*, not a reminder.

The workflow friction — Claude treating discussion as an implementation cue — is the *first* kind:
a standing preference, not an invisible failure. That became CLAUDE.md §Workflow, not a hook.

### No hook may kill anything

The insights report recommended a SessionStart hook running `lsof -ti:3000 | xargs kill -9`.
Rejected: **the process holding port 3000 is as likely to be the user's deliberately-started server
as it is debris.** Every hook detects and reports. The entire snapshot/diff mechanism exists for no
other purpose than letting the report distinguish "yours" from "this session's".

This is the constraint to check first against any future change here.

### False positives cost more than bypasses

The matching helper `invokes()` is a best-effort backstop against a *forgetful* Claude, not an
evasion-proof gate — the model it guards against writes `npm run dev`, not an obfuscated form. That
ordering decided four separate choices: heredoc bodies and quoted spans are stripped before
matching; `sh -c` is left as a documented, test-pinned bypass; the Stop hook exits silently rather
than report without a baseline; single-file `rm -f` is not gated. A bypass means the guard is
silent. A false positive blocks real work — and a false *orphan report* hands the user a `kill`
aimed at their own server, which is the one outcome the paragraph above forbids.

### Environment facts, established by testing

The reusable part. All three were found by running against real processes, and each had already
produced a wrong design before it was caught:

- **`lsof` cannot see network sockets under WSL2.** `lsof -ti:3000` exits 1 against a plainly
  listening server. The insights report's suggested hook would have silently no-opped forever.
  `ss` is the primary, `fuser` the fallback.
- **`pgrep -f "next dev"` self-matches** the hook's own shell wrapper — the whole command string
  lands in its cmdline — so it false-positives on every invocation. Port-based detection instead,
  and `[n]ode_modules/.bin/next build` with the bracket trick where pgrep is unavoidable.
- **A real build's decisive cmdline is `node <repo>/node_modules/.bin/next build`**, not
  `npm run build`.

### Rejected: narrowing the SessionStart matcher

Worth recording because it looks correct and is not. A review found that the unmatched SessionStart
hook re-baselines and clears the warned set on `/clear`, `/compact` and resume, and proposed
restricting the matcher to `startup`. That breaks the mechanism: `clear` and `resume` are also
SessionEnd *reasons*, so `/clear` deletes the state and then re-enters SessionStart. A hook ignoring
`clear` leaves the Stop hook with no baseline at all, and every port holder is reported as debris —
the exact failure the snapshot exists to prevent. The real defect was that the write was
unconditional. Fixed by writing only when absent; the matcher is unchanged.

Requirements and accepted limitations: `docs/specs/260730-claude-hooks-spec.md`.

## 2026-08-03 — Orphan detection by process age; the snapshot mechanism is gone

Supersedes the two sections above it on baselines. The write-only-when-absent fix did not hold:
`/clear` and `resume` are SessionEnd *reasons*, so SessionEnd deleted the state and SessionStart
then found nothing to preserve. Reproduced — `/clear` took snapshot `[12345] -> []`, warned
`[99999] -> []`. `fork` was never covered at all.

**The baseline file was the wrong primitive.** A port holder younger than the `claude` process is
one this session started; that needs no state, so there is nothing to establish, nothing to lose on
re-entry, and nothing to clean up. The SessionStart and SessionEnd hooks are deleted and the hook
surface drops from six to four. Three review findings dissolved rather than being patched.

### The fact that nearly shipped a dead check

**A hook's `$PPID` is not the `claude` process** — it is a per-invocation `/bin/sh -c` wrapper whose
own `etimes` is always 0. The obvious one-liner (`ps -o etimes= -p $PPID`) would have read 0,
classified every port holder as older than the session, reported nothing ever, and passed every
test. Caught by instrumenting a live hook rather than reasoning about it:

```
10987  1464  0     /bin/sh -c ".../guard-build.sh"
 1464    10  2778  claude
```

Session age must be found by walking up to the nearest `comm=claude`, not at a fixed depth. Note a
Bash *tool call*'s `$PPID` **is** `claude` directly — only hooks get the extra layer, so measuring
one and generalising to the other is precisely how this bug is reintroduced.

### False positives cost more than bypasses — except where they don't

The 2026-07-31 rule was derived from the dev-server and build guards, which emit `deny`, and then
applied to the destructive guard, which emits `ask`. There a false positive costs one keystroke
while a miss costs `node_modules`, `data/` or `.env`. The destructive guard now matches with a
stricter variant that sees inside `sh -c "..."`; the two `deny` guards keep the lenient one, and
not merely by preference — they blank quotes first, so the wrapper would have nothing to match.

### `git clean` was the biggest hole, and nothing was watching it

`rm -rf` was gated; `git clean -fdx` was not. Here it removes `data/` (9.0G), `.env`,
`.claude/plans/`, `certificates/` and `docs/handoffs/` — none of it recoverable from git. Also
newly gated: `git reset --hard`, `git checkout --`, `git restore`, and **any `rm` naming a
gitignored path**, which is what finally covers `rm data/raid-tracker.db` — a file, so no recursive
flag was ever involved.

That last rule uses `git check-ignore` rather than a hardcoded list of precious paths. Of 20
gitignored entries only ~5 are regenerable; a hand-drafted list was already missing five real ones
when written. Consequence accepted: CLAUDE.md's restore step `rm data/raid-tracker.db-wal` now
prompts.

### Two more things testing settled

- **The build guard's detection path had never been executed** — every assertion checked only
  "allow when nothing is running". Confirmed against a real build: `next_build_pids()` matches the
  `node .../node_modules/.bin/next build` process only, not the two `sh -c` wrappers, the npm
  wrapper, or the webpack/postcss workers.
- **The test suite was deleting the live hook state directory**, silently disabling the orphan check
  of any running session. The state path is now overridable and the suite points at a throwaway.

Requirements and accepted limitations: `docs/specs/260730-claude-hooks-spec.md`.
Behavioural suite: `bash .claude/hooks/test-hooks.sh` (87 assertions).

---

## 2026-09-04 — Shipping the GoS 10k Archive: cache headers and the copy runbook

Two halves of the Archive (ADR 0007) live partly outside this repo: the Cloudflare rule that
decides what a browser actually caches for `/gos10k`, and the manual copy that puts the database
on the box. Neither can be enforced by a code comment, so both are here.

### Cache headers: the one page where a stale response is correct

Every other route on this site fights staleness. `/gos10k` is the opposite — it serves a frozen,
complete dataset whose last row was written on 2026-08-09 and will never gain another. There is no
such thing as stale data here, so the route sets a long `max-age` plus `immutable` via
`archiveCacheControl()` in `src/lib/http/cache.ts`, rather than the
`max-age=0, s-maxage=N, stale-while-revalidate=M` shape the live API routes use.

**The origin header is not the answer, and reading this file's 2026-07-26 entry is not optional.**
Cloudflare cache rules — which are not in this repo — rewrite what reaches the browser, and a rule
whose Browser TTL is left *unset* does not pass the origin value through: it falls back to the
zone-level default of **4 hours**. That is how `/api/live-stats` ended up serving `max-age=14400`
while the repo had never emitted a non-zero `max-age` anywhere.

For `/gos10k` a 4h browser TTL would be harmless — it is less than what the origin asks for. The
failure that matters here is the opposite one: a rule that *shortens* it, or a Bypass rule matching
`/gos10k` because it looked dynamic.

**Required verification, on prod, after the first deploy** — not from the code, from the wire:

```bash
curl -sSI https://destinyfarmfinder.qzz.io/gos10k | grep -iE 'cache-control|cf-cache-status|age'
```

Expected: the `max-age` and `immutable` the route sets, and `cf-cache-status: HIT` on the second
request. `DYNAMIC` means no cache rule matches the path — a miss, not an error, but the page is
then uncached at the edge and every hit reads SQLite on the box. `BYPASS` means a rule is actively
excluding it. **Record the observed values here when the check is run; until then this section
describes intent, not confirmed behaviour.**

**Observed locally, 2026-09-04** (`next start` on port 3123, no Cloudflare in front):

```
cache-control: public, max-age=86400, s-maxage=86400, immutable
```

That settles the half of the question that does not need prod: Next does *not* overwrite the
middleware header with the `private, no-cache, no-store` it emits for dynamic routes, which was the
plausible silent failure. What the edge does with it is still unverified, and the `curl` above is
still required.

### Copy runbook: two files, by hand, no CI check

Nothing in CI or `npm run build` touches either database, deliberately (ADR 0007). Both copies are
manual and both matter for different reasons.

```bash
# 1. Rebuild the serving copy and its committed manifest from the master.
npm run build-gos10k

# 2. The serving copy — what the app reads. ~71 MB.
scp data/gos-10k.db oracle:~/destiny-farm-finder/data/gos-10k.db

# 3. The master — the off-machine backup. ~119 MB. NOT read by the app.
scp gos10k/destiny_pgcrs.db oracle:~/gos10k-master/destiny_pgcrs.db

# 4. Restart the web processes so the new file is opened and re-verified.
pm2 restart web
```

Step 3 is the part that is easy to skip and expensive to have skipped. `CLAUDE.md` tolerates having
no continuous replication because crawled Tracker data is re-crawlable; the master is not, in any
cheap sense — re-deriving it means re-crawling 13,420 PGCRs, and Bungie's activity history is not
guaranteed to stay fetchable indefinitely. Until step 3 runs, the master exists on exactly one
laptop.

Cloud object storage (R2) is better in principle and was rejected for now: it adds credentials and
a process for a file that will never change again.

**Step 1 is not optional if the master changed.** `getArchiveDb()` verifies the serving copy's row
counts against the committed manifest on first open and throws if they disagree. That check is what
stands in for the build-time failure the dynamic rendering choice gave up — a truncated or stale
`scp` is a loud 500 on `/gos10k`, not a plausible wrong number.
