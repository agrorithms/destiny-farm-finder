# Destiny Farm Finder

Tracks Destiny 2 raid activity in near real time: which players are raiding right now, and who
has completed what. A set of background crawlers observes the Bungie API and writes to SQLite;
the web app only reads.

## Language

**Tracker**:
The live system: `data/raid-tracker.db`, the crawlers that fill it, and the leaderboards and
active sessions read off it. Always changing. Every unqualified term below is a Tracker term.
_Avoid_: the database, the app, production data

**Archive**:
A frozen, complete, read-only historical dataset served alongside the Tracker but never joined to
it. Complete means the crawl that produced it finished and will not run again; frozen means the
file is an artifact, built once and copied into place, never written by the app. The **GoS 10k**
(`data/gos-10k.db`) is the first and today the only one. An Archive has its own connection, its
own query module and its own senses of the terms below — where they differ, the entry says so.
_Avoid_: snapshot, historical database, the second DB

**Fireteam**:
A group of players playing a Destiny activity together. The unit users care about — every card on
the active-sessions page is one fireteam.
_Avoid_: party, group, team, squad, lobby

**Active Session**:
A fireteam observed to be inside a raid right now. Ceases to be active when the crawler confirms
the raid ended, or when the observation goes stale.
_Avoid_: live session, current activity, in-progress raid

**Roster**:
The players making up a fireteam, as reported by Bungie. May be incomplete — Bungie does not
always disclose every member — so a roster of one usually means limited visibility rather than a
genuine solo run.
_Avoid_: party members, participants, players in session

**Tracked Player**:
A player the system knows about and will poll for activity. Identified by `Name#Code`; a player
becomes tracked by being discovered in a raid alongside someone already tracked.
_Avoid_: user, account, member

**Raid**:
Destiny's six-player endgame activity, and the only activity type the leaderboards and the
active-sessions list cover. Other activities are observed but never displayed.
_Avoid_: activity (too broad), instance

**Full Clear**:
A raid that began at the first encounter, as opposed to at a checkpoint, and reached the final
boss. Both halves are required, and each has its own signal: only Bungie's own report that the
activity began at the start establishes the first — no other signal is authoritative, and the
derived one that looked like it was had been wrong ever since Bungie stopped publishing the field
it read. The second means **at least one** player finished, not all of them, so a Full Clear can
contain players who did not finish it themselves. That is what separates it from a Completion,
which is about one particular player.

**In the Archive the first half cannot be established the same way**, because Bungie did not
populate its start-of-activity report for the whole of the history the GoS 10k covers. Zero runs
at or before **2022-02-21** carry the flag, so the Archive names two Full Clear rules and reports
which one it used:

- **Pinned Full Clear** — the flag after 2022-02-21, `starting_phase_index = 0` at or before it.
  Reconciles to exactly **10,000**, which is why it is the Archive's default. The pin instant is
  instance `10141395454`, the subject's *own last clear before a 40-day gap with no GoS runs* — it
  is where the evidence runs out, not a boundary Bungie chose, and the id means nothing else.
- **Disjunctive Full Clear** — flag set **or** phase index 0, anywhere in the history. **10,020.**
  Comparable to the Tracker, generous by 20 runs before the flag was reliable.

Both carry the second half — that the subject himself finished — inside the named rule rather than
leaving it to the caller. Dropping it returns 10,040 / 13,412: plausible-looking numbers that are
wrong. The pinned rule reads a stored column that already folds in "someone finished it", so its
gap is only 40 runs — the fireteam cleared them from the start without him. A 40-run error is
harder to notice than a 3,400-run one, not less wrong. See `src/lib/db/archive/queries.ts`.
_Avoid_: complete run, fresh run

**Checkpoint Run**:
A raid entered partway through, at a saved encounter. Observed and stored like any other run, but
never counted toward a leaderboard. The majority of raids we see.
_Avoid_: partial run, CP run

**Completion**:
One full clear finished by a particular player, counted once per raid instance however many
characters they brought to it. The unit every leaderboard ranks by. A player being present for a
cleared raid is not enough — they must have finished it themselves.
_Avoid_: clear, kill, run

**Heartbeat**:
The crawler's periodic signal that it is still observing. Its age is the Data Freshness; once it
lapses, the site reports itself as no longer live.
_Avoid_: ping, health check, status

**Data Freshness**:
How long ago the crawler last confirmed it was working — the age of what the site knows. The only
freshness that says anything about whether a leaderboard or an active session can be trusted.
_Avoid_: last updated, uptime

**Page Freshness**:
How long ago a browser tab last fetched — the age of what is on screen. Says nothing about whether
the data behind it is current: a tab can be seconds old and still be displaying hours-old data.
_Avoid_: last updated, refresh time

**Farm**:
Repeatedly replaying a single raid encounter or checkpoint for rewards, rather than progressing
through the raid. The activity the site is named for.
_Avoid_: grind, rerun

**Run**:
In the Archive, one raid instance the subject entered — **not necessarily one he finished**. The
`completed` column says whether he did; `source` says which crawl found it
(`get_activity_history` was completions-only, `get_activity_history_unfiltered` added the 3,397 he
started and abandoned). A count of Runs is a count of attempts, and any question about *clears*
must say so with one of the Full Clear rules above.
_Avoid_: clear, raid, activity

**Helper**:
Anyone other than the Archive's subject who appears in one of his Runs, identified by `Name#Code`
like any other player. Named for what the dataset is about — the people who got him to 10,000 —
and deliberately not "teammate": a Helper is a fact about one player's history, not a symmetric
relationship, and someone who joined a checkpoint run he abandoned is still a Helper.
_Avoid_: teammate, fireteam member, participant

**Player-Run**:
One player in one raid instance — the datum every population statistic is counted in. Distinct
from a Completion, which requires the run to be a finished Full Clear: a Player-Run counts whether
they cleared, joined at a checkpoint, or dropped out. A player who brought two characters to the
same instance is still one Player-Run, and today only their first-observed character's kills,
deaths and assists are kept.
_Avoid_: participant, entry, appearance

**All Attempts**:
Every raid instance observed in a window, whatever became of it — Full Clears, Checkpoint Runs and
runs nobody finished. The counterpart to Full Clear, and the broader of the two scopes any
population statistic can be reported under.
_Avoid_: all runs, everything, unfiltered

**KDA Quartiles**:
The spread of KDA across a raid's Player-Runs: the 25th, 50th and 75th percentile of
`(kills + assists) / max(deaths, 1)`, each one a score some player actually achieved. Answers what
a typical player does in this raid, and how widely players differ. Every Player-Run counts once,
however active it was.
_Avoid_: average KDA, median KDA, KDA

**Aggregate KDA**:
A raid's or a player's combined kill economy: `(sum of kills + sum of assists) / sum of deaths`
across every Player-Run in scope. Weighted by activity — the busiest runs move it most — so it
answers what the population as a whole did, not what any one player is likely to do. Routinely
disagrees with the KDA Quartiles, and the disagreement is the point.
_Avoid_: average KDA, total KDA, KDA
