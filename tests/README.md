# Tests

## Running them

```bash
npm test              # everything, once. Fast, hermetic, no network.
npm run test:watch    # re-runs on save
npm run test:coverage # adds a coverage table. No thresholds — it's a diagnostic, not a gate.

npx vitest run tests/db/leaderboard.test.ts   # one file
npx vitest run -t 'checkpoint'                 # tests whose name matches
```

Browser tests are a separate runner and a separate command — see the table below
and `docs/handoffs/260803-playwright-e2e.md`:

```bash
npm run e2e           # build, then drive Chromium
npm run e2e:nobuild   # skip the build (fast; wrong if .next is stale)
```

`npm run e2e` pins a dummy `NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY` into the build. Next inlines
`NEXT_PUBLIC_*` at *build* time, so it has to be on `next-build` and cannot be set from
`playwright.config.ts`; without it `getPublicApiKey()` throws before the Bungie stub fires and
the client-write specs fail on a fresh clone or in CI. A fake value is correct — every
bungie.net request is answered by the interceptor in `e2e/support/test-fixtures.ts`. Because
`e2e:nobuild` does not rebuild, it inherits whatever key the last build baked in.

`npm test` is meant to stay fast and reachable from anywhere. It never touches the network and
never touches the real database — if it ever does either, that's a bug in the test, not a
tolerable shortcut.

## `npm test` vs `npm run e2e` vs `npm run e2e:maintenance`

Three different things that all deserve to exist.

| | `npm test` | `npm run e2e` | `npm run e2e:maintenance` |
|---|---|---|---|
| Runner | Vitest | Playwright | A bespoke script |
| What | Unit and query-level tests | The app in a real browser | The maintenance-cycle harness |
| Speed | Under a second | ~10s plus a Next build | Minutes |
| Needs | Nothing | Chromium; builds and serves the app on port 3100 | Spawns real crawler/scanner processes against a mock Bungie server |
| In CI | Yes — `test.yml`, every push and PR | Yes — its own `e2e.yml`, `pull_request` + manual only | No — too slow, too many moving parts |

**File naming is what keeps the two test runners apart.** `.test.ts` is Vitest;
`.spec.ts` under `e2e/` is Playwright. Vitest's `include` lists its own
directories and its `exclude` names `e2e/**`; Playwright sets `testDir: './e2e'`
and `testMatch: '**/*.spec.ts'`. If a file ends up in front of the wrong runner it
fails with something that reads like a broken test — `Playwright Test did not
expect test.describe() to be called here` — rather than like a misplaced file.

`scripts/test-maintenance-cycle.ts` predates this framework and is correct for what it does. It is
not being ported or absorbed into Vitest. It was only renamed, from `test-maintenance-cycle` to
`e2e:maintenance`, so that `npm test` unambiguously means "fast, hermetic, no network".

## Layout

```
tests/
├── db/                  tests that need a database
├── fixtures/            captured Bungie PGCR JSON + README
├── helpers/             builders, seeding, db access — SHARED with e2e/
└── setup/               global setup: db path, network guard
src/**/*.test.ts         pure-logic tests, next to what they cover
e2e/**/*.spec.ts         Playwright browser tests (different runner)
```

### `tests/helpers/` is shared by both runners

The Playwright suite seeds its fixture database through these same helpers, on
purpose: `seedRun` funnels through `insertFullPGCR`, so both suites agree on what
a seeded raid run is. A private e2e seeder would drift, and drift in *seeding* is
how a green suite ends up asserting against rows production could never create.

Two constraints follow, and breaking either produces an error nowhere near its
cause:

- **Never import from `vitest` in `tests/helpers/`.** Playwright loads these files
  too, and it has no `vi`, no `afterAll`. (This is why `tests/setup/test-db-path.ts`
  could not be reused for e2e — it imports `afterAll` — and `e2e/support/fixture-db.ts`
  reimplements the same technique instead.)
- **Use relative imports, not the `@/` alias.** Playwright's loader does not apply
  tsconfig `paths` when loading `globalSetup`; adding `baseUrl` does not change it.
  Relative paths resolve under both runners.

Colocated or under `tests/`? Colocate when the test needs nothing but the module — it moves with
the code it covers. Put it under `tests/` when it needs a database, a fixture, or a helper.

## The two ground rules

**Never mock our own modules.** `vi.mock('@/lib/db/queries')` tests the mock. The database is real
— `better-sqlite3` opens one in about a millisecond, faster than the mock scaffolding it replaces,
and it validates the actual SQL. See [ADR 0004](../docs/adr/0004-mock-only-at-the-network-boundary.md).

**Mock `fetch`, and only `fetch`.** `tests/setup/no-network.ts` replaces it with a thrower before
every test, so a test reaching the real internet fails loudly rather than quietly burning Bungie
API quota. Stub it deliberately when you need a response:

```ts
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ErrorCode":1}')));
```

No cleanup needed — the guard re-arms itself before the next test.

## Adding a test

**Pure logic** — colocate it, import directly, done:

```ts
// src/lib/crawler/pgcr.test.ts
import { processPGCR } from './pgcr';
import { buildPGCR, buildFireteam } from '../../../tests/helpers/pgcr-builder';

it('counts the run as completed when a single member finished', () => {
    const pgcr = buildPGCR({ entries: buildFireteam({ size: 6, completions: 1 }) });
    expect(processPGCR(pgcr).completed).toBe(true);
});
```

**Anything touching the database** — reset in `beforeEach`, seed through the helpers:

```ts
// tests/db/whatever.test.ts
import { resetTestDb } from '../helpers/db';
import { seedRun, seedPlayer, hoursAgo } from '../helpers/seed';

beforeEach(() => { resetTestDb(); });

it('excludes a checkpoint run', () => {
    seedRun({ instanceId: '1', completedBy: ['p1'], startedFromBeginning: false });
    expect(runLeaderboardRows(24, [], 10)).toEqual([]);
});
```

Each test file gets its own throwaway database in a temp directory, created with the production
schema. You don't have to set it up — `tests/setup/test-db-path.ts` handles it before your imports
run. A real file rather than `:memory:` for a specific reason:
[ADR 0003](../docs/adr/0003-tests-run-against-a-real-sqlite-file.md).

**`test-db-path.ts` must stay first in `setupFiles`, and `getDb()` enforces it.** `DB_PATH` in
`src/lib/db/index.ts` is a module-level const resolved at *import* time, so if anything imports the
db module before `test-db-path.ts` has pointed `DB_PATH` at the throwaway file, the whole suite
binds to the real database — and `resetTestDb()`'s `DELETE FROM`s land on your live dev data.
Don't reorder `setupFiles` in `vitest.config.ts` and don't convert `test-db-path.ts` into a helper
that some test imports. `getDb()` refuses to open anything but the throwaway DB while `VITEST` is
set, so a break fails loudly with `Refusing to open …` rather than silently destroying data.
`openMaintenanceDb()` is deliberately left unguarded — see ADR 0003 for why.

So if you ever see `Refusing to open … under Vitest`, that setup file didn't run before something
imported `src/lib/db` — check the `setupFiles` order rather than working around the error.

`seedRun` goes through `insertFullPGCR`, the same chokepoint all four production ingestion sources
use — so seeded rows are rows production could actually create. Don't reach for raw `INSERT`s.

**Fixtures or builders?** Fixtures when the point is "this is what Bungie really sends". Builders
when you need to vary one field across cases. See [fixtures/README.md](./fixtures/README.md).

## Writing them

Name a test as a claim about behaviour, not a description of code. `excludes a run that nobody
completed` beats `test filter logic`. When you read a failure at 2am, the name is what you get.

Comment the *why* when it isn't obvious from the name — especially when a test pins behaviour
that's wrong but current. Those are labelled `BUG:` and say so in the comment, so nobody "fixes"
the test instead of the code.
