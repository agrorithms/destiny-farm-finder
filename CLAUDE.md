# Destiny Farm Finder

Real-time Destiny 2 raid completion tracker. SQLite database fed by background crawlers against the Bungie API; Next.js app reads from the DB and serves live leaderboards + active fireteam sessions.

**Two databases, and the distinction qualifies nearly every rule below.** The **Tracker** is the
live system — `data/raid-tracker.db`, the crawlers, the leaderboards, the active sessions — and is
what an unqualified rule here means. An **Archive** is a frozen, complete, read-only historical
dataset served alongside it and never joined to it; the **GoS 10k** (`data/gos-10k.db`,
`src/lib/db/archive/`) is the first. See `CONTEXT.md` and
[ADR 0007](docs/adr/0007-the-archive-is-a-second-read-only-database.md).

## Note

- NEVER overwrite files in ~/.claude/plans/ 

## Workflow

**Discussion is the default; implementation is opt-in.**

When I ask a question — anything phrased as "why", "how does", "explain", "what are the options", "is this a concern", "should we", "validate this note" — answer it and stop. Do not write files, create a plan, edit code, or run mutating commands. Read-only investigation to ground the answer is expected and welcome.

Implementation starts only when I say so explicitly: "implement it", "go ahead", "execute the plan". Absent those words, assume we are still talking. If you think you have enough to start building, say so and wait rather than starting.

**Before proposing a root cause, gather evidence first.**

State your top 2–3 hypotheses and, for each, the specific command, query, log, or header that would confirm or kill it. Run those checks and show the raw output before recommending a fix. If I contradict a hypothesis with data, drop it — do not refine it into a new version of the same theory. My most recent change is not a privileged suspect: rule out the alternatives before blaming it.

**Checkpoint long builds.**

For anything touching more than ~8 files, write a progress file listing each file with a checkbox, update it as you go, and make a WIP commit per logical chunk. I review diffs before they land, and one 20-file blob is not reviewable. Do not commit unless the change is on a branch.

**Verification.**

The `verify` skill (`.claude/skills/verify/SKILL.md`) is the build/launch/drive recipe — read it before verifying anything by hand. After a multi-file change run `npm run lint`, then `npm run build`, then `npm test`, and report the real output. Never report a change as working without it.

Chromium **is** installed (Playwright). If a change affects client-side request sequencing or rendering, `npm run e2e` can actually verify it — but the browser suite covers only six flows today (leaderboard filtering, the active-session fireteam cap, `Name#Code` rendering, theme persistence, and the client-write verify + resolve chains), plus one server-side spec that drives the client-write guard over HTTP with no browser page. Outside those, browser behaviour is still unverified, and saying so plainly beats implying the server-side checks covered it. `docs/handoffs/260803-playwright-e2e.md` lists what is and isn't covered.

**Environment.**

Port and build-lock hygiene is enforced by hooks in `.claude/hooks/` — a dev server or build already running will be reported to you rather than silently collided with. When you do stop a dev server, kill the actual `next dev`/`next-server` PID, not just the `npm` wrapper. Never kill a server you did not start without asking. `lsof` cannot see network sockets under WSL2 — use `ss` or `fuser` for port checks.

## Commands

`package.json` has the full list. The non-obvious ones:

- `npm run start` — **web app only.** The crawler/scanner/discovery are separate PM2 processes (`ecosystem.config.js`) and must be started independently.
- `npm run build-gos10k` — rebuilds `data/gos-10k.db` (the Archive serving copy) from the master under `gos10k/`, dropping the raw-PGCR table, and rewrites the committed manifest at `src/lib/db/archive/gos-10k-manifest.json`. Neither database is in git; the script is. Re-run it and re-`scp` after any change to the master, or `getArchiveDb()` will refuse the file.
- `npm run extract-archive-fixture` — regenerates `tests/fixtures/archive-seed.json` from the same master. Committed output; needs the master present.
- `npm run setup-manifest` — writes `data/manifest-cache.json` for a human to read. Changes nothing about runtime behaviour; see the raid-detection convention below.
- `npm run e2e` — Playwright browser tests. Builds, then serves the app on **port 3100** against a throwaway seeded database. Not in `npm test`; runs in CI via its own `e2e.yml` on `pull_request` + `workflow_dispatch`, never on `push`. The script pins a dummy `NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY` into the build — Next inlines `NEXT_PUBLIC_*` at build time, and the client-write specs throw on a missing key before the Bungie stub can fire. `npm run e2e:nobuild` skips the build for fast iteration, is wrong if `.next` is stale, and inherits whatever key the last build baked in.
- `npm run e2e:maintenance` — slow, spawns real crawler/scanner processes against a mock Bungie server. Deliberately outside `npm test` and CI. Unrelated to `npm run e2e` despite the name.

Scripts run via `tsx` using `tsconfig.scripts.json`. Next.js app and scripts compile separately.

## Conventions that will burn you if missed

- **Player identity is `Name#Code`.** Always store and display `bungie_global_display_name` in full. Partial names were a real bug — see recent commits.
- **Raid detection is a hardcoded table, not a runtime cache lookup.** `RAID_DEFINITIONS` in `src/lib/bungie/manifest.ts` is a literal map of raid key → name/slug/activity hashes, flattened into a hash→key `Map` at import time. Nothing reads `data/manifest-cache.json` at runtime. Adding a new raid means **editing `manifest.ts`** — `npm run setup-manifest` only writes the cache file for a human to read.
- **Dedicated scanner key pool** (`BUNGIE_SCANNER_API_KEY`, `_2`) — the scanner rotates only within its own keys, and each key gets its own RPS budget. Don't share scanner keys across other processes.
- **All SQL lives in one query module per database.** The Tracker's is `src/lib/db/queries.ts`; the GoS 10k Archive's is `src/lib/db/archive/queries.ts`. API routes and server components call them directly — no ORM, no service layer. The rule is per-database, not one file overall: `queries.ts` is ~1,700 lines over an implicit `getDb()`, and mixing a second connection into it would make the database ambiguous per function.
- **The Archive's full-clear rules are named functions, and each one already includes "and the subject finished it."** Dropping that conjunct returns a number ~30% high that still looks plausible. Two of the four things this codebase calls a full clear are the Tracker's (`FULL_CLEAR`, `COMPLETION`); two are the Archive's. See `CONTEXT.md`'s `Full Clear` entry and issue #70.
- **`gos10k/` is how the Archive's data was *collected*; `scripts/` and `src/` are how it is *served*.** `gos10k/` is finished, keeps its own pinned `vitest.config.ts`, has no npm scripts and is deliberately outside CI. Anything ongoing — the serving-copy build, the fixture extract — belongs in `scripts/` where `tsconfig.scripts.json` and CI cover it.
- **API cache headers are only half the story** — Cloudflare cache rules (not in this repo) rewrite them, and a rule with no Browser TTL falls back to a 4h zone default. Check `cf-cache-status` and the header prod actually returns before touching `src/lib/http/cache.ts`. See `docs/decisions.md`.

## Env vars

Core: `BUNGIE_API_KEY`, `BUNGIE_SCANNER_API_KEY`, `BUNGIE_SCANNER_API_KEY_2`, `BUNGIE_SCANNER_API_KEY_3`, `BUNGIE_SCANNER_API_KEY_4`, `BUNGIE_DISCOVERY_API_KEY`, `ADMIN_STATS_USERNAME` / `ADMIN_STATS_PASSWORD`, `SEED_PLAYERS`.

Archive: `GOS10K_ARCHIVE_DB_PATH` (default `data/gos-10k.db`) — the serving copy, opened `readonly` + `fileMustExist`. A missing or mismatched file 500s `/gos10k` on first access and nothing else; that is deliberate (ADR 0007).

Web: `NEXT_PUBLIC_SITE_URL` (default `https://destinyfarmfinder.qzz.io`) — sets `metadataBase` for social-share unfurls **and** the same-origin allowlist for the client-write guard. `NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY` — public key used by browser-side Bungie calls (profile + LinkedProfiles resolution). `PAGE_TOKEN_SECRET` (optional, server-only) — when set, enables the short-lived HMAC page-token check on the client-write endpoints (`active-session-update`, `players/identity`, `queue-crawl`); when unset, those endpoints still enforce the same-origin check but skip the token layer. See `src/lib/http/request-auth.ts`.

Tuning — the scripts below list every knob and its default. These are the ones whose *value* is load-bearing for a reason the code doesn't explain:

- `SQLITE_BUSY_TIMEOUT_MS` (30000) — how long any process waits on a competing write lock before SQLITE_BUSY. The wait blocks that process's event loop.
- `CRAWLER_MEMBER_RESOLVE_CONCURRENCY` (4) — member resolution runs concurrently rather than one-at-a-time; sequential resolution of the full `CRAWLER_MEMBER_RESOLVE_LIMIT` could run ~25 × fetch-timeout ≈ 12.5 min and trip the poll watchdog on its own.
- `BUNGIE_GAME_SERVER_BACKOFF_SEC` (2) — self-imposed per-key pause when Bungie returns ErrorCode 1672 `DestinyThrottledByGameServer`, which arrives with `ThrottleSeconds: 0`.
- `CRAWLER_CLEANUP_BATCH_SIZE` (500) — expired PGCRs deleted per cleanup transaction, sized to keep each write-lock hold sub-second; one whole-backlog DELETE would hold the write lock for minutes and freeze the crawler's event loop. `CRAWLER_CLEANUP_YIELD_MS` (25) pauses between batches so the session/crawl loops and the scanner interleave.

Active-session display (`/active-sessions` + the StatsBar/OG count): `ACTIVE_SESSION_DISPLAY_LIMIT` (default 600 — max **fireteams** rendered; counted in fireteams, never rows) and `ACTIVE_SESSION_ROW_SCAN_LIMIT` (default 3000 — max raw per-player rows scanned before dedupe). These are two different units and must stay separate: `active_sessions` is keyed by `membership_id`, so one fireteam yields up to 6 rows, and capping rows silently drops the longest-running raids. See `docs/adr/0001-fireteam-denominated-display-cap.md`. Verify with `npx tsx scripts/verify-active-session-limit.ts` (needs the crawler running — 900s freshness window).

Active-session poll backoff (players found offline/private are snoozed instead of re-polled every cycle; maintained by `recordSessionCheck` on `players.next_session_eligible_at`): `SESSION_OFFLINE_BACKOFF_BASE_SEC` (default 120), `SESSION_OFFLINE_BACKOFF_CAP_SEC` (default 960 ≈ 16 min), `SESSION_PRIVACY_BACKOFF_SEC` (default 21600 = 6h).

Full list: `scripts/start-crawler.ts`, `scripts/start-scanner.ts`, `scripts/discover.ts`.

## Active-session loop resilience

The active-session poll loop shares an event loop and a singleton Bungie client with the crawl loop, and a single hung request used to park it indefinitely (observed: overnight stalls) while the crawl heartbeat stayed green. Four guards close this off: a per-poll watchdog, a `finally`-anchored reschedule, a completion-anchored `session_heartbeat`, and treating a timeout as distinct from "offline" so a Bungie storm can't delete live fireteams. Don't remove one without reading [ADR 0005](docs/adr/0005-active-session-loop-resilience.md).

## Backups

There is **no continuous replication.** Backups are manual snapshots: `npx tsx scripts/backup-db.ts` checkpoints the WAL and `VACUUM INTO`s a dated copy alongside the live DB (`data/raid-tracker.backup-YYYY-MM-DD.db`). It needs ~1 DB size of free disk. Restoring is a file move: stop the processes, swap the snapshot into `data/raid-tracker.db` (remove stale `-wal`/`-shm` files), restart. Crawled data is re-crawlable, which is why this is tolerable.

**That reasoning does not transfer to an Archive.** Re-deriving the GoS 10k master means re-crawling
13,420 PGCRs from Bungie, and its history is not guaranteed to stay fetchable. Both the master
(`gos10k/destiny_pgcrs.db`) and the serving copy are copied to the Oracle box by hand — runbook in
`docs/decisions.md`.

## Testing

Vitest. **`tests/README.md` is the how-to** — read it before writing or changing a test; it covers the two ground rules (mock `fetch` and only `fetch`; `npm test` stays hermetic), the layout, colocate-vs-`tests/`, fixtures-vs-builders, and the naming conventions. The rationale is in [ADR 0003](docs/adr/0003-tests-run-against-a-real-sqlite-file.md) and [ADR 0004](docs/adr/0004-mock-only-at-the-network-boundary.md); the build-out is in `docs/handoffs/testing-framework-handoff.md`. CI runs `npm test` (plus lint and `tsc`) on every push and PR via `test.yml`; the browser suite has its own `e2e.yml` on `pull_request` and manual dispatch only.

**Never reorder `setupFiles` in `vitest.config.ts`** — `tests/setup/test-db-path.ts` must stay first or the suite binds to the live dev database and `resetTestDb()` deletes from it. `getDb()` enforces this; `tests/README.md` explains why.

**Two runners, kept apart by file naming.** `.test.ts` is Vitest, `.spec.ts` under `e2e/` is Playwright. `tests/helpers/` is shared by both, so it must never import from `vitest` and must use relative imports rather than the `@/` alias — Playwright's loader doesn't apply tsconfig `paths` to `globalSetup`. The e2e suite points at its own throwaway database and proves it with a canary row checked through the running server before any spec runs; see [ADR 0003](docs/adr/0003-tests-run-against-a-real-sqlite-file.md).

Application code was not changed to make anything testable — if a test seems to require that, question it first.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `agrorithms/destiny-public`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (labels match canonical role names). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
