# The Archive is a second, read-only database, verified at open rather than at build

The app now reads two SQLite files. The **Tracker** (`data/raid-tracker.db`) is the live system the
crawlers write to. The **Archive** (`data/gos-10k.db`) is a frozen, complete, read-only historical
dataset — the GoS 10k — built once from a master collected under `gos10k/` and copied into place.
Neither is joined to the other; they share a process and nothing else.

Numbered 0007 rather than 0006: `0006-population-kda-quartiles-and-dual-scope.md` was already
claimed on a branch when this was written.

## Why a second file rather than more tables

The Archive is finished. Nothing will insert into it again, the crawlers have no reason to see it,
and every rule that governs the Tracker — the write-lock budget, the WAL settings, the busy
timeout, the backup story — is about a database being written to. Folding 13,420 frozen runs into
the Tracker would put a permanent artifact behind a schema that migrates, a maintenance vacuum that
rewrites, and a 2.5 GB file that already dominates the box's disk.

Keeping it separate is what makes `readonly: true` and `fileMustExist: true` available at all, and
those two flags are the whole safety story: the data cannot be corrupted by this app, and SQLite
cannot silently create an empty database and have the page render "0 runs" — which was the real
disaster scenario, because it looks like an answer.

## Why the app opens it dynamically instead of baking the pages at build time

The route is a server component with `force-dynamic`. The rejected alternative was full static
generation, and it has one genuine advantage that has to be recorded rather than waved away:

**Static fails at build time.** A forgotten `scp` breaks `npm run build` — loud, pre-deploy,
nothing bad reaches a user. Dynamic turns the same mistake into a runtime 500 that someone finds by
opening the link.

It loses on everything else:

- **Build coupling is contagious.** CI runs lint, `tsc` and `npm test` on every push. A build that
  reads `data/gos-10k.db` needs that file in CI too, or a conditional-skip branch — and a
  conditional build is how you ship a production build that silently baked zero pages.
- **~13k static renders on a 2-OCPU ARM box**, on top of `next build` and `tsc`.
- **It does not buy the interactivity the page is for.** Arbitrary filter, sort and drill-down
  combinations cannot be pre-baked, so client-fetch routes get added anyway: the dynamic
  architecture *plus* a slow build.

Read-only SQLite over a ~71 MB frozen file is sub-millisecond, so there is no performance argument
on the other side.

## What buys back the build-time failure: verification at first open

`scripts/build-gos10k-serving-db.ts` emits a committed manifest — row counts per table, plus the
build date and the master's own row counts — and `getArchiveDb()` checks the row counts against the
file it just opened, once per process, on first access. A truncated, stale or simply wrong file
throws with the mismatch spelled out instead of serving a plausible number.

This is deliberately a *loud runtime* failure and deliberately *only* on this route. Throwing at
module load or from instrumentation would convert a forgotten `scp` into a full-site outage; the
Archive is a bolt-on dataset and a missing file is an operator error on one page, not a reason to
stop serving leaderboards. Returning a null handle and rendering an "unavailable" state was also
rejected — at a glance it is indistinguishable from a page that legitimately has no data.

Row counts, not a whole-file checksum, for the per-open check: a 71 MB sha256 on every cold process
start buys precision over a failure mode (a file corrupted in a way that preserves every row count)
that no plausible operator mistake produces. The sha256 is in the manifest for a human to check
after a copy; the row counts are what the process checks for itself.

## What ships in the file

The master is ~119 MB. The serving copy is `VACUUM INTO`'d with `gos_10k_pgcr_raw` dropped — that
table is a local replay archive whose entire purpose is re-parsing without touching Bungie, and it
has no function in production. Weapons stay: dropping them would save another ~49 MB, but loadout
analytics are a stated future bonus and re-shipping the file later is a manual step someone has to
remember. File size is not the constrained dimension here; manual steps are.

## The full-clear rules live in the query module, both of them, complete

Bungie did not populate `activityWasStartedFromBeginning` for the whole of the covered history, so
"full clear" has two defensible readings in the Archive that give different numbers (10,000 and
10,020). Both are named functions over stored columns rather than one rule burned into the schema,
so choosing which the page headlines is a call site, not a migration.

Each named rule carries the *subject completed it* conjunct inside itself. Without it they return
10,040 and 13,412 — plausible, and wrong. The disjunctive rule is 34% high that way; the pinned one
reads a stored column that already folds in "at least one player finished", so it is out by only 40
runs the fireteam cleared from the start without him. The small gap makes it harder to spot. That is the single most likely bug in this feature and
the reason the predicate is not left composable at the call site. It joins the Tracker's two
predicates (`FULL_CLEAR`, `COMPLETION`, ADR 0006 and issue #70) as the third and fourth things in
this codebase called "full clear"; all four are named apart on purpose.

## Consequences

- **Two databases, two connections, two query modules.** `CLAUDE.md`'s "all SQL lives in
  `src/lib/db/queries.ts`" is now per-database. The rule was always "one place per database"; it
  simply never had a second database to prove it.
- **The test-path guard covers N databases**, not "the database" — see the amendment to ADR 0003.
  Generalising it cost ~20 lines and left no hole to document.
- **A missing or wrong `data/gos-10k.db` 500s `/gos10k` and nothing else.** Deployment gains two
  `scp` steps that no CI check enforces; the manifest check is what notices.
- **The master needs a real backup.** `CLAUDE.md` tolerates having no continuous replication
  *because crawled data is re-crawlable*. That reasoning does not transfer: re-deriving the master
  means re-crawling 13,420 PGCRs, and Bungie's history is not guaranteed to stay fetchable. The
  runbook is in `docs/decisions.md`.
- **`gos10k/` stays outside CI.** It is how the data was collected — done, frozen. The build and
  extract scripts were never collection code and live in `scripts/`, typechecked like everything
  else there.
- **No browser coverage.** The e2e suite mints its own Tracker database and knows nothing about the
  Archive. `/gos10k` is verified by Vitest and by hand, and by nothing in Chromium.
