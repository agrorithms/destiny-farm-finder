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
