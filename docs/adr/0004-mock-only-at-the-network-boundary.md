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

## Consequences

- Test databases are real; see ADR 0003 for why they are files rather than
  `:memory:`.
- Tests that need a specific Bungie response stub `fetch` explicitly. The guard
  records itself as the original, so the block is restored automatically for the
  next test with no per-file cleanup.
- Fixtures are captured from the live API rather than hand-authored, so they
  encode Bungie's real quirks instead of our beliefs about them. Builders in
  `tests/helpers/` cover permutations where only one field needs to vary.
