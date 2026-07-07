// Single source of truth for collapsing duplicate active-session rows.
//
// `active_sessions` is keyed by `membership_id` (one row per *tracked player*, with no
// instance_id), so a fireteam with N tracked members yields N rows for the SAME session.
// Both the /active-sessions API (display list) and the OG cards (live count) must collapse
// these the same way, or the numbers drift.
import { getActiveSessions } from '../db/queries';
import { haveSameMembers, isSubset, uniqueSortedMemberIds } from './member-set';

/** Minimal fields needed to decide whether two rows are the same fireteam session. */
export interface DedupeKey {
    activityHash: number;
    /** Membership IDs of everyone in the fireteam (order-insensitive). */
    memberIds: string[];
    /** Unix seconds; newer rows win when suppressing subset/superset variants. */
    checkedAt: number;
    /** ISO timestamp; tiebreaker after checkedAt. */
    startedAt: string;
}

/**
 * Collapse sessions where multiple tracked players are in the same fireteam. Newest rows win,
 * then older subset/superset variants for the same `activityHash` (e.g. A,B vs A,B,C) are
 * suppressed. Returns the kept items in newest-first order.
 */
export function dedupeActiveSessions<T>(items: T[], keyOf: (item: T) => DedupeKey): T[] {
    const withKeys = items.map((item) => ({ item, key: keyOf(item) }));

    const sorted = [...withKeys].sort((a, b) => {
        const checkedDiff = Number(b.key.checkedAt || 0) - Number(a.key.checkedAt || 0);
        if (checkedDiff !== 0) return checkedDiff;
        return Date.parse(b.key.startedAt || '') - Date.parse(a.key.startedAt || '');
    });

    const kept: { item: T; members: string[]; activityHash: number }[] = [];

    for (const { item, key } of sorted) {
        const members = uniqueSortedMemberIds(key.memberIds);
        if (members.length === 0) continue;

        let suppressed = false;
        for (const existing of kept) {
            if (existing.activityHash !== key.activityHash) continue;
            if (
                haveSameMembers(members, existing.members) ||
                isSubset(members, existing.members) ||
                isSubset(existing.members, members)
            ) {
                suppressed = true;
                break;
            }
        }

        if (!suppressed) {
            kept.push({ item, members, activityHash: key.activityHash });
        }
    }

    return kept.map((k) => k.item);
}

function parseMemberIds(partyMembersJson: string | null | undefined): string[] {
    if (!partyMembersJson) return [];
    try {
        const parsed: unknown = JSON.parse(partyMembersJson);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((value) => {
                if (!value || typeof value !== 'object') return '';
                const id = (value as Record<string, unknown>).membershipId;
                return typeof id === 'string' ? id : String(id || '');
            })
            .filter((id) => id.length > 0);
    } catch {
        return [];
    }
}

/**
 * Accurate count of distinct active raid fireteams (de-duped). This is the number the
 * /active-sessions page displays; OG cards use it so their count matches. Returns 0 on a
 * database-maintenance error rather than throwing.
 */
export function countActiveRaidSessions(): number {
    try {
        const rows = getActiveSessions(undefined, 200, true);
        const deduped = dedupeActiveSessions(rows, (row) => ({
            activityHash: row.activityHash,
            memberIds: parseMemberIds(row.partyMembersJson),
            checkedAt: row.checkedAt,
            startedAt: row.startedAt,
        }));
        return deduped.length;
    } catch {
        return 0;
    }
}
