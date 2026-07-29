/**
 * Which of the two freshness clocks the StatsBar should show.
 *
 * `page`  — how long ago this tab fetched (Page Freshness).
 * `data`  — how long ago the crawler last confirmed it was working (Data Freshness).
 * `none`  — no honest number is available; render nothing.
 *
 * See CONTEXT.md for the vocabulary.
 */
export type Freshness =
    | { kind: 'page'; seconds: number }
    | { kind: 'data'; seconds: number }
    | { kind: 'none' };

interface FreshnessInput {
    /** Crawler heartbeat is within its liveness window (`getCrawlerStatus().isRunning`). */
    live: boolean;
    /** Server-computed age of the crawler heartbeat; null when unknown (maintenance / DB error). */
    secondsSinceHeartbeat: number | null;
    /** Client-computed age of this tab's last fetch; null before the first one lands. */
    secondsSincePageUpdate: number | null;
}

/**
 * One slot, two clocks. While the crawler is live the data is current by
 * definition, so the only interesting age is the page's. Once the heartbeat
 * lapses that flips: the page keeps refreshing happily, but it is refreshing
 * stale data, and continuing to show the page's age would read as reassurance
 * ("Updated 8s ago") at precisely the moment the bar should be reporting a
 * problem. When the crawler is down *and* its age is unknown there is nothing
 * truthful to say, and the "Maintenance" / "Updates paused" label already
 * carries the meaning, so the slot is dropped rather than filled with a guess.
 */
export function selectFreshness({
    live,
    secondsSinceHeartbeat,
    secondsSincePageUpdate,
}: FreshnessInput): Freshness {
    if (live) {
        return secondsSincePageUpdate === null
            ? { kind: 'none' }
            : { kind: 'page', seconds: secondsSincePageUpdate };
    }

    return secondsSinceHeartbeat === null
        ? { kind: 'none' }
        : { kind: 'data', seconds: secondsSinceHeartbeat };
}
