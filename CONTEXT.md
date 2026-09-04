# Destiny Farm Finder

Tracks Destiny 2 raid activity in near real time: which players are raiding right now, and who
has completed what. A set of background crawlers observes the Bungie API and writes to SQLite;
the web app only reads.

## Language

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
A raid played from the first encounter through the final boss, as opposed to joining at a
checkpoint. Only Bungie's own report that the activity began at the start establishes this — no
other signal is authoritative, and one that looks like it is has been wrong since Bungie stopped
publishing it.
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
