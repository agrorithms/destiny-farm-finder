import 'dotenv/config';
import path from 'path';
import Database from 'better-sqlite3';

// ==========================================
// CONFIGURATION (Fill these in manually)
// ==========================================
const CONFIG = {
    membershipType: 1, // 1: Xbox, 2: PSN, 3: Steam, 10: Epic
    membershipId: '4611686018437585442',
    // Deliberately unreachable rather than 10000. This is the run's only stop
    // condition, and the loose filter is a superset of true full clears, so a
    // 10000 cap would halt mid-history and print a number that looks like
    // confirmation but is really just the cap. The gap between this count and
    // 10000 is the measurement the PGCR backfill needs.
    targetPgcrCount: 100000,
    // Standalone DB, resolved next to this script rather than to the cwd, so the
    // run lands in the same place regardless of where npx tsx is invoked from.
    // Deliberately NOT data/raid-tracker.db: these rows come from Activity
    // History, not real PGCR fetches, and must not reach the leaderboards.
    dbPath: path.join(__dirname, 'destiny_pgcrs.db'),
    maxRequestsPerSecond: 24, // Hard capped at <= 25
};

// Activities requested per Activity History page. Bungie's max is 250. Also the
// page-exhaustion signal: a short page means there is nothing after it.
const PAGE_COUNT = 250;

// Bound the 429 retry loop so a persistent throttle fails the run instead of
// spinning forever.
const MAX_RETRIES = 5;

const API_KEY = process.env.NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY;
if (!API_KEY) {
    throw new Error(
        'NEXT_PUBLIC_BUNGIE_PUBLIC_API_KEY is not set. Add it to .env at the repo root.'
    );
}

const GOS_HASHES = new Set<number>([
    2659723068, 3458480158, 1042180643, 2497200493, 3845997235,
]);

const HEADERS = { 'X-API-Key': API_KEY };

// ==========================================
// RATE LIMITER & FETCH WRAPPER
// ==========================================
class RateLimiter {
    private maxPerSecond: number;
    private minIntervalMs: number;
    private lastCallTime: number = 0;

    constructor(maxRequestsPerSecond: number) {
        // Hard cap enforced at maximum 25 requests per second
        this.maxPerSecond = Math.min(Math.max(1, maxRequestsPerSecond), 25);
        this.minIntervalMs = 1000 / this.maxPerSecond;
    }

    async wait(): Promise<void> {
        const now = Date.now();
        const elapsed = now - this.lastCallTime;
        const delay = this.minIntervalMs - elapsed;

        if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        this.lastCallTime = Date.now();
    }
}

const limiter = new RateLimiter(CONFIG.maxRequestsPerSecond);

async function rateLimitedFetch(
    url: string,
    headers: Record<string, string>,
    attempt: number = 0
): Promise<any> {
    await limiter.wait();

    const res = await fetch(url, { headers });

    // Handle Bungie HTTP 429 Rate Limit Backoff
    if (res.status === 429) {
        if (attempt >= MAX_RETRIES) {
            throw new Error(`Still rate limited (HTTP 429) after ${MAX_RETRIES} retries — giving up.`);
        }
        const backoffMs = 2000 * (attempt + 1);
        console.warn(`Rate limit hit (HTTP 429)! Backing off ${backoffMs}ms before retry ${attempt + 1}/${MAX_RETRIES}...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return rateLimitedFetch(url, headers, attempt + 1);
    }

    if (!res.ok) {
        throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();

    // Bungie signals most failures as HTTP 200 with ErrorCode != 1 —
    // SystemDisabled (weekly maintenance), DestinyPrivacyRestriction,
    // DestinyThrottledByGameServer. Left unchecked, `data.Response` is undefined,
    // the caller sees an empty activity list, and a transient API error is
    // silently indistinguishable from "end of history" — the run would report a
    // short total as if it were complete. Throw instead: INSERT OR IGNORE makes
    // restarting free. Same check as src/lib/bungie/client.ts.
    if (data?.ErrorCode !== undefined && data.ErrorCode !== 1) {
        const throttle = data.ThrottleSeconds > 0 ? ` (ThrottleSeconds: ${data.ThrottleSeconds})` : '';
        throw new Error(`Bungie API error ${data.ErrorCode} ${data.ErrorStatus}: ${data.Message}${throttle}`);
    }

    return data;
}

// ==========================================
// DATABASE & MAIN WORKFLOW
// ==========================================
interface RunRow {
    instanceId: string;
    characterId: string;
    activityHash: number;
    period: number;
    endedAt: number;
    durationSeconds: number;
    completionReason: number | null;
    playerCount: number;
}

function initDb(): Database.Database {
    const db = new Database(CONFIG.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    db.exec(`
    CREATE TABLE IF NOT EXISTS gos_10k_runs (
      instance_id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      activity_hash INTEGER NOT NULL,
      raid_key TEXT,
      period INTEGER NOT NULL,
      ended_at INTEGER,
      duration_seconds INTEGER DEFAULT 0,
      completion_reason INTEGER,
      -- NULL until a later backfill pass reads them off the PGCR endpoint.
      -- Activity History does not carry either field, so anything written here
      -- from a history row would be invented.
      starting_phase_index INTEGER,
      activity_was_started_from_beginning INTEGER,
      completed INTEGER DEFAULT 0,
      player_count INTEGER DEFAULT 0,
      source TEXT DEFAULT 'unknown',
      fetched_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_gos_10k_runs_period ON gos_10k_runs(period);
  `);

    // Migration guard for a database created before completion_reason existed —
    // CREATE TABLE IF NOT EXISTS is a no-op on it. Same idiom as
    // src/lib/db/schema.ts.
    const columns = db.prepare(`PRAGMA table_info(gos_10k_runs)`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'completion_reason')) {
        db.prepare(`ALTER TABLE gos_10k_runs ADD COLUMN completion_reason INTEGER`).run();
        console.log('Migrated: added completion_reason to gos_10k_runs.');
    }

    return db;
}

interface AccountCharacter {
    characterId: string;
    deleted: boolean;
}

/**
 * Enumerate every character on the account, including deleted ones.
 *
 * Profile components=200 only ever returns *live* characters, so clears made on
 * a since-deleted character are invisible to it. GetHistoricalStatsForAccount
 * keeps a per-character breakdown with a `deleted` flag, and the Activities
 * endpoint still serves history for those ids (verified against this account:
 * one deleted character, activities returned). That is the only way to reach
 * those runs through the API.
 */
async function getAccountCharacters(): Promise<AccountCharacter[]> {
    const url = `https://www.bungie.net/Platform/Destiny2/${CONFIG.membershipType}/Account/${CONFIG.membershipId}/Stats/?groups=General`;
    const data = await rateLimitedFetch(url, HEADERS);

    const characters = data?.Response?.characters;
    if (!Array.isArray(characters) || characters.length === 0) {
        throw new Error('Failed to retrieve account characters. Check membershipId and API key.');
    }

    return characters.map((c: { characterId: string; deleted?: boolean }) => ({
        characterId: c.characterId,
        deleted: c.deleted === true,
    }));
}

async function run() {
    const db = initDb();

    const insert = db.prepare(
        `INSERT OR IGNORE INTO gos_10k_runs (
      instance_id,
      character_id,
      activity_hash,
      raid_key,
      period,
      ended_at,
      duration_seconds,
      completion_reason,
      starting_phase_index,
      activity_was_started_from_beginning,
      completed,
      player_count,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // One commit per page instead of one per row — at 10k rows the per-insert
    // autocommit dominates the run. `budget` is the remaining target: the cap
    // counts *new* rows, and INSERT OR IGNORE only reveals which those are at
    // insert time, so it has to be enforced inside the transaction.
    const insertPage = db.transaction((rows: RunRow[], budget: number) => {
        let inserted = 0;
        let duplicates = 0;

        for (const row of rows) {
            if (inserted >= budget) break;

            const result = insert.run(
                row.instanceId,
                row.characterId,
                row.activityHash,
                'garden-of-salvation',
                row.period,
                row.endedAt,
                row.durationSeconds,
                row.completionReason,
                null, // starting_phase_index — PGCR-only, backfilled later
                null, // activity_was_started_from_beginning — PGCR-only, backfilled later
                1,
                row.playerCount,
                'get_activity_history'
            );

            if (result.changes > 0) inserted++;
            else duplicates++;
        }

        return { inserted, duplicates };
    });

    try {
        const characters = await getAccountCharacters();
        const deletedCount = characters.filter((c) => c.deleted).length;
        console.log(
            `Found ${characters.length} characters on account ` +
            `(${characters.length - deletedCount} live, ${deletedCount} deleted).`
        );

        let recordedCount = 0;
        let duplicateCount = 0;

        for (const { characterId: charId, deleted } of characters) {
            if (recordedCount >= CONFIG.targetPgcrCount) break;
            console.log(`Scanning character ${charId}${deleted ? ' (deleted)' : ''}...`);

            let page = 0;
            let hasMorePages = true;

            while (hasMorePages && recordedCount < CONFIG.targetPgcrCount) {
                const url = `https://www.bungie.net/Platform/Destiny2/${CONFIG.membershipType}/Account/${CONFIG.membershipId}/Character/${charId}/Stats/Activities/?mode=4&count=${PAGE_COUNT}&page=${page}`;
                const data = await rateLimitedFetch(url, HEADERS);

                const activities = data?.Response?.activities || [];
                if (activities.length === 0) break;

                // A page shorter than requested is the last one — stop after
                // processing it rather than spending a request on an empty page.
                if (activities.length < PAGE_COUNT) hasMorePages = false;

                const rows: RunRow[] = [];

                for (const act of activities) {
                    const refId = act.activityDetails.referenceId;
                    const values = act.values || {};

                    // Filter 1: Check if the activity is Garden of Salvation
                    if (!GOS_HASHES.has(refId)) continue;

                    // Filter 2: Target player must have completed the activity.
                    //
                    // Note this is NOT "full clear from the beginning".
                    // Activity History carries no activityWasStartedFromBeginning
                    // or startingPhaseIndex — those are PGCR-only — so a run
                    // joined in progress and then finished passes this filter.
                    // Tightening it to a true full clear needs a PGCR pass over
                    // the stored rows; the two columns stay NULL until then.
                    //
                    // completionReason is recorded but deliberately NOT filtered
                    // on: filtering would pin every stored row to 0 and leave the
                    // column with no variance, which is useless for working out
                    // what the field actually means. Observed so far on this
                    // account: 0 alongside completed=1, 255 alongside
                    // completed=0. Anything else that shows up deeper in the
                    // history now lands in the table where it can be counted.
                    const completionReason = values.completionReason?.basic?.value ?? null;
                    const completed = values.completed?.basic?.value === 1;
                    if (!completed) continue;

                    // Extract and calculate timestamps
                    const startTimestamp = Math.floor(new Date(act.period).getTime() / 1000);
                    const durationSec = values.activityDurationSeconds?.basic?.value || 0;

                    rows.push({
                        instanceId: act.activityDetails.instanceId,
                        characterId: charId,
                        activityHash: refId,
                        period: startTimestamp,
                        endedAt: startTimestamp + durationSec,
                        durationSeconds: durationSec,
                        completionReason,
                        playerCount: values.playerCount?.basic?.value || 0,
                    });
                }

                // INSERT OR IGNORE avoids duplicates across characters
                const { inserted, duplicates } = insertPage(rows, CONFIG.targetPgcrCount - recordedCount);
                recordedCount += inserted;
                duplicateCount += duplicates;

                console.log(
                    `Character ${charId}${deleted ? ' (deleted)' : ''} page ${page}: ${activities.length} activities, ` +
                    `${rows.length} matched, +${inserted} new, ${duplicates} dupes ` +
                    `(${recordedCount}/${CONFIG.targetPgcrCount})`
                );

                page++;
            }
        }

        console.log(`Done! Total unique matching PGCRs recorded: ${recordedCount} (${duplicateCount} already present)`);
        console.log(`Database: ${CONFIG.dbPath}`);
    } finally {
        db.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
