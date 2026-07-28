# Active-session limits are denominated in fireteams, not rows

`active_sessions` is keyed by `membership_id`, so a single fireteam produces up to six rows — one
per tracked player in it. The read path originally capped those raw rows (`ORDER BY started_at
DESC LIMIT 200`) and deduped into fireteams afterwards, which meant the limit was spent on
duplicates and, because it sorted by start time, evicted the longest-running raids first. In
practice ~1000 live rows rendered ~110 cards and nothing older than about five minutes was ever
visible. We now scan a generous bound of raw rows, dedupe into fireteams, and only then apply the
user-facing cap — which is counted in fireteams.

## Consequences

- Two separate limits exist and must not be collapsed into one: `ACTIVE_SESSION_ROW_SCAN_LIMIT`
  (raw rows, default 3000) and `ACTIVE_SESSION_DISPLAY_LIMIT` (fireteams, default 600).
  Re-introducing a single `LIMIT` in SQL restores the bug.
- The row scan is ordered by `checked_at DESC`, not `started_at DESC`. It is served by
  `idx_active_sessions_checked_at`, and if the bound is ever hit it sheds the *stalest* rows —
  the ones closest to ageing out — instead of the longest-running raids.
- Dedupe happens before name enrichment, so the display-name lookup covers only the fireteams
  actually rendered rather than every row scanned.
- The row bound has roughly 2x headroom over what the crawler can produce: at
  `CRAWLER_SESSION_POLLING_LIMIT` rows per cycle across the 900s freshness window, at most ~1500
  rows can be fresh simultaneously. Raising the polling limit materially should prompt a review
  of this bound.
