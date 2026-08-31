# The active-session count reports the true total, not the number of cards shown

`countActiveRaidSessions` feeds the nav StatsBar and the OG share cards, while
`/api/active-sessions` feeds the page. These deliberately no longer agree: the count reports every
live fireteam, whereas the list is capped at `ACTIVE_SESSION_DISPLAY_LIMIT`. The headline number
answers "how busy is Destiny right now", which is the question a share card and a stats bar are
actually asking; capping it to whatever happened to fit on screen would understate real activity
and undersell the site.

This is a deliberate exception to the invariant that `dedupe.ts` was written to protect — that the
count and the list collapse duplicate rows identically. That invariant still holds: both go through
`getDedupedActiveSessions`, so they can never disagree about *what a fireteam is*. Only the cap
differs.

## Consequences

- `/api/active-sessions` returns `total` (all live fireteams) alongside `shown` (those under the
  cap), so the page can disclose the difference rather than hiding sessions silently.
- A discrepancy between the StatsBar number and the visible card count is expected when the cap
  bites, and is not a bug to be "fixed" by capping the count.
- The server logs a warning whenever the cap bites, since the default (600) sits close to observed
  prod volume and the gap would otherwise be invisible.
- The StatsBar counts link to `/leaderboard` and `/active-sessions` without carrying a time range or
  clearing raid filters. The destination honours whatever view the user saved, so the same expected
  discrepancy extends to navigation: clicking "full clears · last 24h" can land a reader on their
  own saved 7-day board, and that is not a broken link.
