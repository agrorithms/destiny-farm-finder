// Pure fireteam member-set helpers shared by the server-side dedupe and the
// client-side session diffing on the active-sessions page. Must stay free of
// server-only imports (db, better-sqlite3) so the client bundle can use it.

export function uniqueSortedMemberIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => String(id || '')).filter((id) => id.length > 0))).sort();
}

export function haveSameMembers(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function isSubset(subset: string[], superset: string[]): boolean {
    if (subset.length > superset.length) return false;
    const supersetSet = new Set(superset);
    return subset.every((id) => supersetSet.has(id));
}
