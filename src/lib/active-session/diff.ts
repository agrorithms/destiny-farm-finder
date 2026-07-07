// Client-side poll-to-poll diffing for the active-sessions page. Pure module —
// no server imports — so it stays out of the server bundle and is unit-testable.
//
// The dedupe layer keeps whichever tracked player's row was checked most recently,
// so a session's `membershipId` can flip between polls for the SAME fireteam.
// Identity for diffing must come from the raid activity + the member set instead.
import { isSubset, uniqueSortedMemberIds } from './member-set';

export interface DiffableSession {
    activityHash: number;
    partyMembers: Array<{ membershipId: string }>;
}

export interface DisplayEntry<T extends DiffableSession> {
    key: string;
    members: string[];
    session: T;
    isNew: boolean;
    ended: boolean;
}

/**
 * Diff the latest poll against the previous display set. Sessions present in both
 * continue as-is; roster churn (someone joined/left, so the member set is a
 * subset/superset of a previous one in the same activity) also counts as continuing.
 * Newly appeared sessions are flagged `isNew` for one cycle; disappeared sessions
 * are held for one cycle as dimmed `ended` entries before dropping out.
 */
export function diffSessions<T extends DiffableSession>(
    sessions: T[],
    prev: Map<string, DisplayEntry<T>> | null,
): DisplayEntry<T>[] {
    const entries: DisplayEntry<T>[] = [];
    const consumedPrevKeys = new Set<string>();

    for (const session of sessions) {
        const members = uniqueSortedMemberIds(session.partyMembers.map((m) => m.membershipId));
        const key = `${session.activityHash}:${members.join(',')}`;

        let carried = prev?.get(key) ?? null;
        if (carried) {
            consumedPrevKeys.add(key);
        } else if (prev) {
            for (const [prevKey, prevEntry] of prev) {
                if (consumedPrevKeys.has(prevKey)) continue;
                if (prevEntry.session.activityHash !== session.activityHash) continue;
                if (isSubset(members, prevEntry.members) || isSubset(prevEntry.members, members)) {
                    carried = prevEntry;
                    consumedPrevKeys.add(prevKey);
                    break;
                }
            }
        }

        entries.push({ key, members, session, isNew: prev !== null && !carried, ended: false });
    }

    if (prev) {
        for (const [prevKey, prevEntry] of prev) {
            if (consumedPrevKeys.has(prevKey)) continue;
            if (prevEntry.ended) continue; // already had its one-cycle hold
            entries.push({ ...prevEntry, isNew: false, ended: true });
        }
    }

    return entries;
}

/** Compact, CSS-safe view-transition-name derived from the session key (djb2). */
export function viewTransitionNameFor(key: string): string {
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
    }
    return `session-${hash.toString(36)}`;
}
