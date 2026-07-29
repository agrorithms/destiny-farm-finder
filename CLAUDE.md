# Destiny Farm Finder

Real-time Destiny 2 raid completion tracker. SQLite database fed by background crawlers against the Bungie API; Next.js app reads from the DB and serves live leaderboards + active fireteam sessions.

## Note

- NEVER overwrite files in ~/.claude/plans/ 

## Commands

`package.json` has the full list. The non-obvious ones:

- `npm run start` — **web app only.** The crawler/scanner/discovery are separate PM2 processes (`ecosystem.config.js`) and must be started independently.
- `npm run setup-manifest` — writes `data/manifest-cache.json` for a human to read. Changes nothing about runtime behaviour; see the raid-detection convention below.
- `npm run e2e:maintenance` — slow, spawns real crawler/scanner processes against a mock Bungie server. Deliberately outside `npm test` and CI.

Scripts run via `tsx` using `tsconfig.scripts.json`. Next.js app and scripts compile separately.

## Conventions that will burn you if missed

- **Player identity is `Name#Code`.** Always store and display `bungie_global_display_name` in full. Partial names were a real bug — see recent commits.
- **Raid detection is a hardcoded table, not a runtime cache lookup.** `RAID_DEFINITIONS` in `src/lib/bungie/manifest.ts` is a literal map of raid key → name/slug/activity hashes, flattened into a hash→key `Map` at import time. Nothing reads `data/manifest-cache.json` at runtime. Adding a new raid means **editing `manifest.ts`** — `npm run setup-manifest` only writes the cache file for a human to read.
- **Dedicated scanner key pool** (`BUNGIE_SCANNER_API_KEY`, `_2`) — the scanner rotates only within its own keys, and each key gets its own RPS budget. Don't share scanner keys across other processes.
- **All SQL lives in `src/lib/db/queries.ts`.** API routes call it directly — no ORM, no service layer.
- **API cache headers are only half the story** — Cloudflare cache rules (not in this repo) rewrite them, and a rule with no Browser TTL falls back to a 4h zone default. Check `cf-cache-status` and the header prod actually returns before touching `src/lib/http/cache.ts`. See `docs/decisions.md`.

## Env vars

Core: `BUNGIE_API_KEY`, `BUNGIE_SCANNER_API_KEY`, `BUNGIE_SCANNER_API_KEY_2`, `BUNGIE_SCANNER_API_KEY_3`, `BUNGIE_SCANNER_API_KEY_4`, `BUNGIE_DISCOVERY_API_KEY`, `ADMIN_STATS_USERNAME` / `ADMIN_STATS_PASSWORD`, `SEED_PLAYERS`.

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

## Testing

Vitest. **`tests/README.md` is the how-to** — read it before writing or changing a test; it covers the two ground rules (mock `fetch` and only `fetch`; `npm test` stays hermetic), the layout, colocate-vs-`tests/`, fixtures-vs-builders, and the naming conventions. The rationale is in [ADR 0003](docs/adr/0003-tests-run-against-a-real-sqlite-file.md) and [ADR 0004](docs/adr/0004-mock-only-at-the-network-boundary.md); the build-out is in `docs/handoffs/testing-framework-handoff.md`. CI runs `npm test` only.

**Never reorder `setupFiles` in `vitest.config.ts`** — `tests/setup/test-db-path.ts` must stay first or the suite binds to the live dev database and `resetTestDb()` deletes from it. `getDb()` enforces this; `tests/README.md` explains why.

Application code was not changed to make anything testable — if a test seems to require that, question it first.
