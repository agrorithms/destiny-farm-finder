# PGCR fixtures

Real Bungie PGCR responses, captured verbatim. PGCR data is public, so these are committed as-is.

## Why captured, not hand-written

A hand-authored PGCR encodes what we *believe* the API returns. These fixtures exist to check that
belief, so writing them ourselves would defeat the point. Bungie's real responses carry quirks we
would not think to invent: `startingPhaseIndex` absent entirely, entry counts above six, activity
durations that disagree with every player's reported time.

Use a fixture when the point is "this is what Bungie really sends". Use a builder from
`../helpers/pgcr-builder.ts` when you need to vary one field across several cases. Fixtures for
realism, builders for permutation.

## Capturing

```bash
npm run capture-fixtures
```

Reads `BUNGIE_API_KEY` from `.env` and writes every fixture below. Re-running overwrites them.

The script prints the salient fields for each capture — entry count, completion count,
`fromBeginning`, duration versus longest time played, missing names — so a fixture that no longer
demonstrates its stated case is visible rather than silently wrong. Bungie does occasionally stop
serving old PGCRs; if a capture starts failing, pick a replacement instance and update
`scripts/capture-pgcr-fixture.ts`.

Every instance ID was chosen by querying the production database for runs that actually exhibit
the property in question, so each is a real observed run rather than a hypothetical.

## The fixtures

| File | Instance | What makes it interesting |
|---|---|---|
| `pgcr-fullclear-salvations-edge.json` | 17091392013 | Baseline. Six players, started from the beginning, completed. |
| `pgcr-checkpoint-root-of-nightmares.json` | 17091462346 | `activityWasStartedFromBeginning` is false — a checkpoint run, which every leaderboard must exclude. |
| `pgcr-zero-completions-vault-of-glass.json` | 17091467640 | No entry has `completed = 1`. The most common shape in the table: 55% of stored PGCRs. |
| `pgcr-partial-completion-last-wish.json` | 17091283535 | Some finished, some didn't. `completed` is per-entry and ANY completion counts the run. |
| `pgcr-duration-divergence-garden.json` | 17091200569 | Activity duration (~2069s) far exceeds the longest per-player time (~981s). Tier 1 vs Tier 2 derivation diverge. |
| `pgcr-no-duration-crotas-end.json` | 17091316490 | Stored with a NULL `ended_at` — no duration was derivable. Exercises the Tier 3 fallback. |
| `pgcr-missing-bungie-name.json` | 16975643976 | At least one entry lacks `bungieGlobalDisplayName`. Player extraction must tolerate it. |
| `pgcr-non-raid.json` | probed | A non-raid activity, so `isRaidActivityHash` rejects it. Found by probing forward from a known raid instance until one isn't a raid. |

None of these are synthetic. If a case ever becomes uncapturable and has to be hand-edited from a
real fixture, say so in this table with what was changed and why.

## A case that cannot be captured

The original brief asked for a checkpoint fixture identified by `startingPhaseIndex > 0`. **No such
PGCR exists to capture.** Bungie has stopped sending `startingPhaseIndex` — it is absent on all
827,076 rows in the production database. Checkpoint runs are identified by
`activityWasStartedFromBeginning` instead, which is what
`pgcr-checkpoint-root-of-nightmares.json` covers. See `docs/decisions.md`.
