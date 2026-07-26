// Single source of truth for collapsing duplicate active-session rows.
//
// `active_sessions` is keyed by `membership_id` (one row per *tracked player*, with no
// instance_id), so a fireteam with N tracked members yields N rows for the SAME session.
// Both the /active-sessions API (display list) and the OG cards (live count) must collapse
// these the same way, or the numbers drift.
import { getActiveSessions, type ActiveSessionDbRow } from '../db/queries';

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

function uniqueSortedMemberIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => String(id || '')).filter((id) => id.length > 0))).sort();
}

function haveSameMembers(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function isSubset(subset: string[], superset: string[]): boolean {
    if (subset.length > superset.length) return false;
    const supersetSet = new Set(superset);
    return subset.every((id) => supersetSet.has(id));
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

// Maximum fireteams rendered on the page. Denominated in FIRETEAMS, not rows — the previous
// row-denominated limit collapsed to ~110 cards and hid every long-running raid. See docs/adr/0001.
export const ACTIVE_SESSION_DISPLAY_LIMIT = Math.max(
    1,
    parseInt(process.env.ACTIVE_SESSION_DISPLAY_LIMIT || '600', 10)
);

/**
 * Every distinct active raid fireteam currently live, de-duped from the per-player rows.
 * Single source of truth for both the /active-sessions list and the headline count, so the
 * two can't drift. Bounded only by the row-scan limit — the *display* cap is applied by the
 * caller, after sorting, so no caller can accidentally truncate by row again.
 */
export function getDedupedActiveSessions(raidKey?: string): ActiveSessionDbRow[] {
    const rows = getActiveSessions(raidKey, undefined, true);
    return dedupeActiveSessions(rows, (row) => ({
        activityHash: row.activityHash,
        memberIds: parseMemberIds(row.partyMembersJson),
        checkedAt: row.checkedAt,
        startedAt: row.startedAt,
    }));
}

/**
 * Display ordering for the active-sessions list: fireteams with more than one visible member
 * first, then newest first. A single-member session is usually a transitory-visibility artifact
 * (we couldn't read the fireteam) rather than a genuine solo run, so it ranks below real
 * fireteams — and is the first thing dropped if the display cap bites.
 */
export function compareSessionsForDisplay(
    a: { memberCount: number; startedAt: string },
    b: { memberCount: number; startedAt: string }
): number {
    const aSolo = a.memberCount > 1 ? 0 : 1;
    const bSolo = b.memberCount > 1 ? 0 : 1;
    if (aSolo !== bSolo) return aSolo - bSolo;
    return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0);
}

/**
 * Count of distinct active raid fireteams, used by the StatsBar and the OG share cards.
 * This is the TRUE total and may legitimately exceed the number of cards the page renders
 * (which is capped) — it answers "how busy is Destiny right now". See docs/adr/0002.
 * Returns 0 on a database-maintenance error rather than throwing.
 */
export function countActiveRaidSessions(): number {
    try {
        return getDedupedActiveSessions().length;
    } catch {
        return 0;
    }
}
