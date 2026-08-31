# Mock only at the network boundary

Tests stub `fetch` and nothing else. There is no `vi.mock()` of any module in
`src/`, and the database is real rather than faked. This is a deliberate
constraint, not an oversight — mocking our own modules is the default habit in
most test suites, so the absence needs explaining before someone helpfully adds it.

## Why

Leaderboard integrity is the product. The failure that matters here is not a
crash but a silently wrong row set, and that failure lives in exactly the places
mocking would erase: the SQL, and the shape of what Bungie actually returns.

- **Mocking `@/lib/db/queries` would test the mock.** A test asserting that
  `getLeaderboard` returns what the mock was told to return proves nothing about
  whether the SQL selects the right runs. `better-sqlite3` opens a database in
  about a millisecond, so a real one is both faster than the mock scaffolding and
  actually load-bearing.
- **Seeding goes through `insertFullPGCR`, not raw INSERTs.** All four production
  ingestion sources funnel through that function, and it is where `ended_at` is
  derived and `players.last_seen_at` advanced. Raw inserts would let tests build
  rows that production could never produce, so the tests would pass against
  impossible data.
- **`fetch` is the one boundary worth faking.** It is genuinely external, genuinely
  slow, rate-limited, and returns different data every day. Everything on our side
  of it is ours to verify.

A setup file (`tests/setup/no-network.ts`) replaces `fetch` with a thrower before
every test, so a test that reaches the real internet fails loudly instead of
quietly burning Bungie API quota and going flaky against live data.

## Amendment (2026-08-03): the same rule, expressed in a browser

The Playwright suite (`e2e/`) follows this ADR rather than qualifying it.
`e2e/support/test-fixtures.ts` is the browser-side counterpart to
`tests/setup/no-network.ts`: it installs a `page.route` handler on every test that
lets localhost through, answers Bungie and the two telemetry endpoints (Sentry,
umami) with stubs, and aborts anything else while recording it, so an unanticipated
external call fails the test by name instead of becoming silent real traffic.

`tests/setup/no-network.ts` itself does nothing there — it swaps
`globalThis.fetch` in the Node test process, which reaches neither the browser's
JS context nor the Next server. Same intent, different mechanism.

Our own API routes are **not** stubbed. A browser test that mocked
`/api/players/identity` would assert its own fixture; the seam worth testing is
the one where the browser sends a payload, the server parses it, SQLite stores it,
and a re-read enriches it. That is the same argument this ADR makes about
`@/lib/db/queries`, applied one layer out.

## Consequences

- Test databases are real; see ADR 0003 for why they are files rather than
  `:memory:`.
- A *configuration guard* in `src/` is not a mock, and this constraint does not
  forbid one. `getDb()` refuses to open anything but the throwaway database when
  `VITEST` is set (ADR 0003) — it substitutes no behaviour, so it cannot make a
  failing test appear to pass; its only effect is aborting a run that is already
  misconfigured. It is the sole place `src/` knows tests exist, and it is
  deliberate rather than a leak to be tidied away.
- Tests that need a specific Bungie response stub `fetch` explicitly. The guard
  records itself as the original, so the block is restored automatically for the
  next test with no per-file cleanup.
- Fixtures are captured from the live API rather than hand-authored, so they
  encode Bungie's real quirks instead of our beliefs about them. Builders in
  `tests/helpers/` cover permutations where only one field needs to vary.
- `tests/helpers/` is shared by both runners, which is what keeps the two suites
  agreeing on what a seeded raid run is. See `tests/README.md` for the one
  constraint that makes it work.
