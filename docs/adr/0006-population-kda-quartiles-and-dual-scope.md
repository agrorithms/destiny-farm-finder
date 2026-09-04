# Population KDA is a nearest-rank quartile triple plus an aggregate, reported under two scopes

`getRaidStats` originally reported one `avgKda` per raid — the mean of every player's
kills+assists over deaths, scoped to full clears — while `classDistribution` in the same row
counted players from *every* instance, DNFs included. The two metrics silently disagreed about
which instances contributed (issue #56).

Rather than pick a winner, scope becomes part of the response. Every scope-sensitive metric is
reported twice, under **Full Clear** and **All Attempts**, and the analytics UI toggles between
them client-side with no refetch. Scope is a dimension of the data, not a query parameter, because
this is an exploratory control on an endpoint behind a 5-minute SWR cache: making the toggle a
round-trip would thrash the cache and multiply cache keys for a payload difference of a few
numbers per raid.

Two metrics stay outside the toggle because it is meaningless for them. `fastestClearSeconds` is
full-clear-only by definition, and `dnfRate` is degenerate under a full-clear scope — filtering to
full clears forces it to 0. A card-wide toggle would have been lying about half the card.

`avgKda` is replaced, not renamed in place, by two statistics that answer different questions:

- **KDA Quartiles** — p25/p50/p75 of the per-Player-Run KDA, by nearest rank.
- **Aggregate KDA** — `(SUM(kills) + SUM(assists)) / SUM(deaths)` over the same population.

Both are needed because they disagree, and the disagreement is the signal. Measured over the last
168h, Crota's End under All Attempts has a p50 of 24.00 against an aggregate of 45.39: the middle
player-run looks ordinary while the raid's overall economy is dominated by a minority of very
high-activity runs. A single number cannot say that.

Quartiles use **nearest rank** (`ROW_NUMBER()` picking rank `ceil(p·n)`), not linear
interpolation. Every published percentile is therefore a KDA some player actually achieved, and
the method degrades gracefully at tiny samples with no special-casing: at n=1 all three percentiles
are the single observation; at n=2 `p25 = p50 = x1` and `p75 = x2`, from which a client can
reconstruct both raw values exactly. This is why there is no minimum-sample threshold — an
interpolating method would have needed one.

## Consequences

- The response nests scope-sensitive metrics under `fullClear` and `allAttempts`; the nesting *is*
  the documentation of which metrics respond to the toggle, and the client selector is `row[scope]`.
- `kda` is `null` if and only if `sampleSize` is 0 — a raid with instances in-window but no
  Player-Runs in that scope. Every other case returns three real numbers.
- Two counts ship, in two different units, and must not be collapsed: `sampleSize` per scope
  (Player-Runs — 1,084,154 over the last 168h) and `instanceCount` per row (raid instances —
  372,810 over the same window, the denominator of `dnfRate`). This is the same units discipline as
  [ADR 0001](0001-fireteam-denominated-display-cap.md).
- **The `fullClear` scope's population is instance-level, and deliberately admits players who
  did not personally finish.** It is `p.completed = 1 AND p.activity_was_started_from_beginning
  = 1` with no per-player conjunct, so a player present for a clear they did not finish is one of
  its Player-Runs — ~16% of them. That is what separates it from the player-level predicate the
  leaderboard and player pages use, and collapsing the two onto one definition would move the
  published quartiles and class distribution. The pair is `FULL_CLEAR` / `COMPLETION` in
  `src/lib/db/queries.ts`, pinned by `tests/db/full-clear-predicates.test.ts`.
- **Two different zero-death guards coexist in one query, deliberately.** The quartiles use
  per-row `MAX(deaths, 1)`, since a single flawless Player-Run would otherwise divide by zero. The
  aggregate uses `MAX(SUM(deaths), 1)`, which fires only if *every* Player-Run in a raid and scope
  had zero deaths — effectively never. Collapsing them into one guard changes both statistics.
  Under a median the per-row fudge is harmless in a way it was not under the old mean: a flawless
  40-kill run scores 40 and skewed the mean, but moves a rank statistic by one rank.
- Every scope-sensitive statistic is intended to be displayed with its sample size adjacent and
  muted; below three Player-Runs the count is expected to replace the chart. The API supplies the
  numbers unconditionally — the display treatment is #51's to implement.
- The datum is the **Player-Run**, currently approximated by the player's *first-observed
  character*: `pgcr_players` has PK `(instance_id, membership_id)` and inserts with
  `INSERT OR IGNORE`, so for the ~0.5% of PGCRs with multiple character entries per player, the
  later characters' kills/deaths/assists are dropped. This is inherited from the old `avgKda`, not
  introduced here, and a rank statistic absorbs it better than a mean did. Issue #43 makes the
  datum exact; it is a refinement, not a prerequisite.

## Cost, measured

Against the live database (2.5 GB) over a 168h window — 1,084,154 Player-Runs across 372,810 raid
instances. Three runs each, interleaved so no query gets an unfair page-cache advantage:

| query | runs (ms) |
|---|---|
| old `avgKda` (mean of ratios), full-clear | 404 / 364 / 383 |
| old `classDistribution`, all rows | 1511 / 1374 / 1401 |
| new CTE — quartiles + aggregate, Full Clear scope | 972 / 898 / 883 |
| new CTE — quartiles + aggregate, All Attempts scope | 3692 / 3412 / 3438 |

So roughly **1.8 s today against 4.3 s after** — about 2.4x, per cache key, for four statistics
instead of two. Note the Full Clear CTE is *faster* than the `classDistribution` query it partly
replaces: the cost tracks population size, not the window function. All Attempts is expensive
because it ranks all 1.08M Player-Runs; Full Clear ranks a small fraction of them.

**Amendment (2026-08-29), after the follow-up cleanup.** The table above measured only the two new
CTEs against the two queries they replaced; the shipped endpoint also ran a scalar query and *two*
`classDistribution` queries (one per scope), so the real cold-miss cost was higher than the 4.3 s
row-sum suggests. The cleanup folded the class counts into each scope's CTE via `json_group_object`
over the same `runs` population, marked `runs` as `MATERIALIZED` (SQLite was re-evaluating the
`pgcrs` join once per CTE reference), precomputed the three nearest-rank positions in `totals`, and
filtered the rank join to `r.rn IN (t.r25, t.r50, t.r75)`. Four statements became two, and the base
join now runs once per scope instead of three times. Verified byte-identical output across all 25
raid/scope pairs; measured on the 2026-08-23 backup (818 MB, 89,502 Player-Runs over 168h): Full
Clear 91 ms → 61 ms, All Attempts 397 ms → 305 ms, both including the class counts. That database is
~12x smaller than the one the table above was measured against, so read the ratio, not the absolute
numbers — and the live figures in the table have not been re-measured since.

The aggregate contributes almost none of this — it is three `SUM()`s over a CTE already being
materialised. The sort is the cost: `ORDER BY kda` ranks a computed ratio, so SQLite cannot use the
covering index `sqlite_autoindex_pgcr_players_1` that serves the current queries, and falls back to
row lookups plus a sort of the whole scope.

This is accepted. better-sqlite3 is synchronous, so the compute blocks its PM2 worker's event loop
for its duration, but `swr-cache` runs stale and warmed revalidations in the background — only a
cold miss awaits it, and at this site's traffic (~5 visitors/day, 2 workers) a ~4 s stall on a
worker restart or a first-time filter combination is a non-event. It is also only ~2.4x a stall the
endpoint already had.

**The cheap next move, if it stops being one.** If #51's charts make this endpoint hot, or the
filter matrix multiplies cache keys enough that cold misses stop being rare, add a stored generated
column for the per-row KDA on `pgcr_players` and index it, so the rank can be served from an index
instead of a sort. That is a schema migration plus a backfill, and it leaves every query shape and
all four statistics unchanged — which is why it is the first thing to reach for, ahead of a
precomputed rollup table (which adds a writer, a staleness window, and a new crawler
responsibility) or splitting the scopes into separate cache keys (which would undo the no-refetch
toggle this ADR is built around). The trigger to watch is cold-miss frequency, not absolute query
time: the gap is only visible on `X-Cache: MISS`, and it is concentrated entirely in the All
Attempts scope.

These timings scale with retained data. `CRAWLER_CLEANUP_BATCH_SIZE` and the PGCR retention window
set how many Player-Runs a 168h query ranks; a retention increase moves the All Attempts number
first.
