/**
 * Verification for the fireteam-denominated active-session display cap.
 *
 *   npx tsx scripts/verify-active-session-limit.ts
 *
 * Read-only — safe against the dev DB. Requires the crawler to be running (or to have run
 * within the last 900s), since the active-session freshness window is 15 minutes.
 *
 * Reports the old row-denominated behaviour against the new fireteam-denominated one:
 * how many fireteams each surfaces, and how old the oldest visible session is. The old
 * behaviour's headline failure was that the oldest visible session was only minutes old.
 */
import { getDb } from '../src/lib/db';
import {
    ACTIVE_SESSION_DISPLAY_LIMIT,
    compareSessionsForDisplay,
    dedupeActiveSessions,
    getDedupedActiveSessions,
} from '../src/lib/active-session/dedupe';
import { ACTIVE_SESSION_ROW_SCAN_LIMIT, type ActiveSessionDbRow } from '../src/lib/db/queries';

const OLD_ROW_LIMIT = 200;
const FRESHNESS_SECONDS = 900;

function memberIds(partyMembersJson: string | null): string[] {
    if (!partyMembersJson) return [];
    try {
        const parsed = JSON.parse(partyMembersJson) as Array<{ membershipId?: unknown }>;
        return parsed.map((m) => String(m?.membershipId || '')).filter(Boolean);
    } catch {
        return [];
    }
}

function ageMinutes(startedAt: string): number {
    const started = Date.parse(startedAt);
    if (Number.isNaN(started)) return 0;
    return Math.round((Date.now() - started) / 60_000);
}

function oldestVisibleMinutes(sessions: ActiveSessionDbRow[]): number {
    return sessions.reduce((max, s) => Math.max(max, ageMinutes(s.startedAt)), 0);
}

const db = getDb();
const cutoff = Math.floor(Date.now() / 1000) - FRESHNESS_SECONDS;

const freshRaidRows = (db.prepare(`
  SELECT COUNT(*) AS c FROM active_sessions
  WHERE checked_at >= ? AND (activity_mode_type = 4 OR raid_key IS NOT NULL)
`).get(cutoff) as { c: number }).c;

if (freshRaidRows === 0) {
    console.error(
        'No fresh raid rows in the last 900s. Start the crawler (npm run crawler) and retry.\n'
        + 'On WSL2, also check the system clock has not drifted — that alone can empty this window.'
    );
    process.exit(1);
}

// OLD behaviour: cap the raw per-player rows, ordered by started_at DESC, then dedupe.
const oldRows = db.prepare(`
  SELECT membership_id AS membershipId, membership_type AS membershipType, display_name AS displayName,
         activity_hash AS activityHash, activity_mode_hash AS activityModeHash,
         activity_mode_type AS activityModeType, raid_key AS raidKey, started_at AS startedAt,
         party_members_json AS partyMembersJson, player_count AS playerCount, checked_at AS checkedAt
  FROM active_sessions
  WHERE checked_at >= ? AND (activity_mode_type = 4 OR raid_key IS NOT NULL)
  ORDER BY started_at DESC LIMIT ?
`).all(cutoff, OLD_ROW_LIMIT) as ActiveSessionDbRow[];

const oldFireteams = dedupeActiveSessions(oldRows, (row) => ({
    activityHash: row.activityHash,
    memberIds: memberIds(row.partyMembersJson),
    checkedAt: row.checkedAt,
    startedAt: row.startedAt,
}));

// NEW behaviour: scan up to the row bound, dedupe, sort for display, then cap in fireteams.
const startedAt = Date.now();
const newFireteams = getDedupedActiveSessions();
const dedupeMs = Date.now() - startedAt;

const rosterSize = (session: ActiveSessionDbRow): number =>
    new Set(memberIds(session.partyMembersJson)).size;

newFireteams.sort((a, b) => compareSessionsForDisplay(
    { memberCount: rosterSize(a), startedAt: a.startedAt },
    { memberCount: rosterSize(b), startedAt: b.startedAt }
));
const shown = newFireteams.slice(0, ACTIVE_SESSION_DISPLAY_LIMIT);

console.log(`\nfresh raid rows in window: ${freshRaidRows}`);
console.log(`row scan limit: ${ACTIVE_SESSION_ROW_SCAN_LIMIT}   display limit: ${ACTIVE_SESSION_DISPLAY_LIMIT} fireteams`);
console.log(`dedupe cost: ${dedupeMs}ms\n`);

console.log('                       rows scanned   fireteams   oldest visible');
console.log(`  OLD (LIMIT ${OLD_ROW_LIMIT} rows)   ${String(oldRows.length).padStart(12)}   ${String(oldFireteams.length).padStart(9)}   ${oldestVisibleMinutes(oldFireteams)}m`);
console.log(`  NEW (fireteam cap)   ${String(freshRaidRows).padStart(12)}   ${String(shown.length).padStart(9)}   ${oldestVisibleMinutes(shown)}m`);

const hist = new Map<number, number>();
for (const session of newFireteams) {
    const size = rosterSize(session);
    hist.set(size, (hist.get(size) || 0) + 1);
}
console.log('\nroster sizes across all live fireteams:');
for (const size of [...hist.keys()].sort((a, b) => a - b)) {
    console.log(`  ${size} member${size === 1 ? ' ' : 's'}: ${hist.get(size)}`);
}

// Decision 4: no multi-member fireteam may appear after a single-member one.
const firstSolo = newFireteams.findIndex((s) => rosterSize(s) <= 1);
const soloOrderingHolds = firstSolo < 0
    || newFireteams.slice(firstSolo).every((s) => rosterSize(s) <= 1);

// Within each tier, newest first.
const recencyHolds = newFireteams.every((session, i) => {
    if (i === 0) return true;
    const prev = newFireteams[i - 1];
    if ((rosterSize(prev) > 1) !== (rosterSize(session) > 1)) return true; // tier boundary
    return (Date.parse(prev.startedAt) || 0) >= (Date.parse(session.startedAt) || 0);
});

let failed = 0;
const check = (ok: boolean, label: string): void => {
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

console.log('\nchecks:');
check(newFireteams.length >= oldFireteams.length, 'new surfaces at least as many fireteams as old');
check(oldestVisibleMinutes(shown) >= oldestVisibleMinutes(oldFireteams), 'new surfaces sessions at least as old as old');
check(soloOrderingHolds, 'single-member sessions sort below real fireteams');
check(recencyHolds, 'within each tier, newest first');
console.log(
    newFireteams.length > ACTIVE_SESSION_DISPLAY_LIMIT
        ? '  INFO  display cap is biting — check server logs for the warning'
        : '  INFO  display cap not biting'
);

console.log('');
process.exit(failed > 0 ? 1 : 0);
