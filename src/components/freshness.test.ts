import { describe, it, expect } from 'vitest';
import { selectFreshness } from './freshness';

// The StatsBar has one slot for "how old is this?", but there are two different
// clocks that could fill it, and they disagree exactly when it matters most:
// a dead crawler means the data is hours old while the page itself was fetched
// seconds ago. These tests pin down which clock wins in which state, because the
// tempting "simplification" — always show one of them — is what makes the bar lie.
// See CONTEXT.md for Data Freshness vs Page Freshness.

describe('selectFreshness', () => {
    it('reports page freshness while the crawler is live', () => {
        // Healthy case: the data is current, so the only interesting number is
        // how long ago this tab last fetched.
        expect(
            selectFreshness({ live: true, secondsSinceHeartbeat: 12, secondsSincePageUpdate: 8 })
        ).toEqual({ kind: 'page', seconds: 8 });
    });

    it('reports data freshness once the crawler heartbeat has lapsed', () => {
        // The bug this prevents: showing "Updated 8s ago" next to "Updates paused".
        // The page is fresh, but it is freshly displaying six-hour-old data.
        expect(
            selectFreshness({ live: false, secondsSinceHeartbeat: 21600, secondsSincePageUpdate: 8 })
        ).toEqual({ kind: 'data', seconds: 21600 });
    });

    it('reports nothing when the crawler is down and its age is unknown', () => {
        // The maintenance / DB-error response sends live:false with a null
        // heartbeat. There is no honest number to show, and the "Maintenance"
        // label already says everything true, so the slot is omitted.
        expect(
            selectFreshness({ live: false, secondsSinceHeartbeat: null, secondsSincePageUpdate: 8 })
        ).toEqual({ kind: 'none' });
    });

    it('reports nothing before the first fetch completes', () => {
        // No poll has returned yet, so neither clock has started.
        expect(
            selectFreshness({ live: true, secondsSinceHeartbeat: 12, secondsSincePageUpdate: null })
        ).toEqual({ kind: 'none' });
    });

    it('treats a zero-second age as a real value, not a missing one', () => {
        // Guards against a `!seconds` truthiness check creeping in: the very
        // first tick after a fetch is legitimately 0 and must still render.
        expect(
            selectFreshness({ live: true, secondsSinceHeartbeat: 0, secondsSincePageUpdate: 0 })
        ).toEqual({ kind: 'page', seconds: 0 });

        expect(
            selectFreshness({ live: false, secondsSinceHeartbeat: 0, secondsSincePageUpdate: 8 })
        ).toEqual({ kind: 'data', seconds: 0 });
    });
});
