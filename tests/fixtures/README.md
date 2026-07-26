# PGCR fixtures

Real Bungie PGCR responses, captured verbatim on 2026-07-26. PGCR data is public, so these are
committed as-is. None are synthetic.

## Why captured, not hand-written

A hand-authored PGCR encodes what we *believe* the API returns. These fixtures exist to check that
belief, so writing them ourselves would defeat the point.

That is not a theoretical concern. Capturing these corrected three things we had wrong, each
inferred from the database rather than observed at the source:

- `startingPhaseIndex` is **present and always `0`**, including on confirmed checkpoint runs. We
  had assumed Bungie stopped sending it, because the writer's `|| 0` had flattened the evidence.
- A "six player" raid report can belong to **two people** with three characters each.
- "No derivable duration" was really **an absurd duration** — 27384s reported for an 18-minute run.

Use a fixture when the point is "this is what Bungie really sends". Use a builder from
`../helpers/pgcr-builder.ts` when you need to vary one field across several cases. Fixtures for
realism, builders for permutation.

## Capturing

```bash
npm run capture-fixtures
```

Reads `BUNGIE_API_KEY` from `.env` and rewrites every fixture below.

The script prints the salient fields for each capture — entry count, completion count,
`fromBeginning`, duration versus longest time played, missing names — so a fixture that no longer
demonstrates its stated case is visible rather than silently wrong. Check that output against the
table below whenever you re-capture. Bungie does eventually stop serving old PGCRs; if a capture
starts failing, pick a replacement instance and update `scripts/capture-pgcr-fixture.ts`.

Every instance ID was chosen by querying the production database for runs exhibiting the property
in question, so each is a real observed run rather than a hypothetical.

## The fixtures

| File | Instance | What makes it interesting |
|---|---|---|
| `pgcr-fullclear-salvations-edge.json` | 17091392013 | Baseline. Six players, six completions, started from the beginning. |
| `pgcr-checkpoint-root-of-nightmares.json` | 17091462346 | `activityWasStartedFromBeginning: false` — a checkpoint run, which every leaderboard must exclude. Seven entries. |
| `pgcr-zero-completions-vault-of-glass.json` | 17091467640 | No entry has `completed = 1`. The most common shape in the table: 55% of stored PGCRs. |
| `pgcr-partial-completion-last-wish.json` | 17091283535 | Two entries, one completion. `completed` is per-entry and ANY completion counts the run. |
| `pgcr-multi-character-garden.json` | 17091200569 | **Six entries, two distinct players** — three characters each. Also a mild Tier 1 vs Tier 2 duration gap (2069s reported, 2037s derivable). |
| `pgcr-absurd-duration-crotas-end.json` | 17091316490 | Reports a **27384s (7.6 hour)** duration for a run where nobody played past 1093s. The megalobby corruption `FUTURE_ENDED_SKEW_SECONDS` exists to reject. |
| `pgcr-missing-bungie-name.json` | 16975643976 | **Nineteen entries, every one anonymous** — `isPublic: false`, `membershipType: 0`, and no name field of any kind. Not "the global name is missing", but no identity at all. |
| `pgcr-non-raid.json` | 17091392014 | A non-raid activity, so `isRaidActivityHash` rejects it. Found by probing forward from a known raid instance. |

## Two cases with no fixture

**A checkpoint run identified by `startingPhaseIndex > 0`.** The original brief asked for this.
No such PGCR exists to capture — the field is `0` on every one of the 827,076 rows in production
*and* on every fixture above, including the three that are genuinely checkpoint runs. Checkpoint
runs are identified by `activityWasStartedFromBeginning` instead, which
`pgcr-checkpoint-root-of-nightmares.json` covers.

**A true Tier 3 run, where no duration is derivable at all.** Every captured PGCR reports a usable
`activityDurationSeconds`. `pgcr-absurd-duration-crotas-end.json` was originally captured expecting
this case — its database row has a NULL `ended_at` — but the NULL came from the future-end-time
guard rejecting a corrupt duration, not from Tier 3. Tier 3 is covered by builders in
`tests/db/ended-at-derivation.test.ts`.

Note that the absurd-duration fixture's NULL-ness is **time dependent**: the guard compares against
the ingest clock, so re-seeding that run today produces a non-NULL `ended_at`. Do not write a test
asserting NULL from that fixture — use a builder, which controls the period explicitly.
