/**
 * Leaderboard-specific caching layer in front of the (unchanged) slow query.
 *
 * Owns: env-driven TTL bands, canonical key normalization, the extracted SQL
 * runner, the limit-collapse (cache top-100, slice after), and response
 * envelope construction. Both the route and the warmer go through here so they
 * share one query path and one single-flight cache (see swr-cache.ts).
 *
 * The ranking aggregation reads the denormalized `pgcrs.ended_at` (Phase 3); for
 * a single raid the aggregate (`IN (?)`) and per-raid (`= ?`) forms are
 * equivalent, so one runner covers all shapes. `fullClearsOnly` is forced true
 * on the cache path (the only real UI path) so it drops out of the key space.
 *
 * `runLeaderboardRows` is the pure, uncached query (the SWR cache only wraps it
 * inside `getLeaderboardResponse`); it is exported so scripts/db-stats.ts can run
 * the raw leaderboard without the cache layer.
 */
import { getDb } from '../db';
import { getAllRaidDefinitions } from '../bungie/manifest';
import { getOrCompute, type CacheState } from './swr-cache';

type SqlParam = string | number;

interface LeaderboardDbRow {
    membershipId: string;
    membershipType: number;
    displayName: string | null;
    bungieGlobalDisplayName: string | null;
    bungieGlobalDisplayNameCode: number | null;
    completions: number;
    lastClearAt: number;
}

export interface LeaderboardResponseEntry {
    membershipId: string;
    membershipType: number;
    displayName: string;
    completions: number;
    /** Competition rank ("1224"): tied completions share a rank, next rank skips by group size. */
    rank: number;
}

export interface IndividualLeaderboard {
    raidKey: string;
    raidName: string;
    entries: LeaderboardResponseEntry[];
}

export type ResponseState = CacheState | 'bypass';

export interface LeaderboardFilters {
    difficulty?: 'normal' | 'master';
    /** Exact unique_player_count match (Solo/Duo/Trio). */
    exactPlayers?: number;
    /** Upper-bound unique_player_count filter (Lowman ≤N). */
    maxPlayers?: number;
}

export interface LeaderboardRequest {
    mode: 'aggregate' | 'individual';
    hours: number;
    /** Validated raid keys as requested (may be empty = all raids). */
    raidKeys: string[];
    limit: number;
    filters?: LeaderboardFilters;
}

export interface CacheBand {
    /** seconds — edge s-maxage */
    sMaxAge: number;
    /** seconds — edge stale-while-revalidate */
    staleWhileRevalidate: number;
    freshMs: number;
    staleMs: number;
    negativeMs: number;
    warmed: boolean;
}

export interface LeaderboardResult {
    body: unknown;
    state: ResponseState;
    band: CacheBand;
}

/** Rows cached per canonical key. The client max limit is 100. */
const CACHED_LIMIT = 100;

/** Windows the warmer keeps hot (band 4: > 48h). */
export const WARM_WINDOWS = [168, 720];

// ── TTL bands ───────────────────────────────────────────────────────────────

function envSeconds(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envMs(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 4 bands by `hours`, named by upper bound. fresh = s-maxage, stale = SWR.
 * Floored at 60s because the client already refetches every 60s.
 */
export function leaderboardCacheBand(hours: number): CacheBand {
    let fresh: number;
    let stale: number;
    let warmed = false;

    if (hours <= 6) {
        fresh = envSeconds('CACHE_FRESH_6H', 60);
        stale = envSeconds('CACHE_SWR_6H', 300);
    } else if (hours <= 24) {
        fresh = envSeconds('CACHE_FRESH_24H', 180);
        stale = envSeconds('CACHE_SWR_24H', 900);
    } else if (hours <= 48) {
        fresh = envSeconds('CACHE_FRESH_48H', 300);
        stale = envSeconds('CACHE_SWR_48H', 1800);
    } else {
        fresh = envSeconds('CACHE_FRESH_720H', 600);
        stale = envSeconds('CACHE_SWR_720H', 3600);
        warmed = true;
    }

    return {
        sMaxAge: fresh,
        staleWhileRevalidate: stale,
        freshMs: fresh * 1000,
        staleMs: stale * 1000,
        negativeMs: envMs('CACHE_NEGATIVE_MS', 20_000),
        warmed,
    };
}

// ── Query runner ─────────────────────────────────────────────────────────────

function formatDisplayName(entry: LeaderboardDbRow): string {
    if (entry.bungieGlobalDisplayName && entry.bungieGlobalDisplayNameCode) {
        return `${entry.bungieGlobalDisplayName}#${String(entry.bungieGlobalDisplayNameCode).padStart(4, '0')}`;
    }
    return entry.bungieGlobalDisplayName || entry.displayName || entry.membershipId;
}

/**
 * Runs the leaderboard aggregation. Empty `raidKeys` = all raids (no filter);
 * a single key yields the same ranking as the per-raid individual query.
 * `fullClearsOnly` is always applied (forced true on every cached + bypass path).
 */
export function runLeaderboardRows(hours: number, raidKeys: string[], limit: number, filters?: LeaderboardFilters): LeaderboardResponseEntry[] {
    const db = getDb();
    const cutoff = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

    let query = `
        SELECT
          pp.membership_id as membershipId,
          pp.membership_type as membershipType,
          COALESCE(pl.bungie_global_display_name, pp.display_name) as displayName,
          pl.bungie_global_display_name as bungieGlobalDisplayName,
          pl.bungie_global_display_name_code as bungieGlobalDisplayNameCode,
          COUNT(DISTINCT pp.instance_id) as completions,
          MAX(p.ended_at) as lastClearAt
        FROM pgcr_players pp
        JOIN pgcrs p ON pp.instance_id = p.instance_id
        LEFT JOIN players pl ON pp.membership_id = pl.membership_id
        WHERE p.ended_at >= ?
          AND pp.completed = 1
          AND p.completed = 1
    `;

    const params: SqlParam[] = [cutoff];

    if (raidKeys.length > 0) {
        const placeholders = raidKeys.map(() => '?').join(',');
        query += ` AND p.raid_key IN (${placeholders})`;
        params.push(...raidKeys);
    }

    if (filters?.difficulty === 'master') {
        query += ` AND p.difficulty_tier > 0`;
    } else if (filters?.difficulty === 'normal') {
        query += ` AND COALESCE(p.difficulty_tier, -1) <= 0`;
    }

    if (filters?.exactPlayers != null) {
        query += ` AND p.unique_player_count = ?`;
        params.push(filters.exactPlayers);
    } else if (filters?.maxPlayers != null) {
        query += ` AND p.unique_player_count IS NOT NULL AND p.unique_player_count <= ?`;
        params.push(filters.maxPlayers);
    }

    query += ` AND p.activity_was_started_from_beginning = 1`;

    // Within a tie group the earliest achiever ranks highest: lastClearAt is the
    // completion time of the most recent counted clear, so a stale PGCR found
    // late still slots the player at their true historical position.
    query += `
        GROUP BY pp.membership_id
        HAVING completions > 0
        ORDER BY completions DESC, lastClearAt ASC, pp.membership_id ASC
        LIMIT ?
    `;
    params.push(limit);

    const rows = db.prepare(query).all(...params) as LeaderboardDbRow[];
    let prevCompletions = -1;
    let prevRank = 0;
    return rows.map((row, index) => {
        const rank = row.completions === prevCompletions ? prevRank : index + 1;
        prevCompletions = row.completions;
        prevRank = rank;
        return {
            membershipId: row.membershipId,
            membershipType: row.membershipType,
            displayName: formatDisplayName(row),
            completions: row.completions,
            rank,
        };
    });
}

const yieldTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Computes the 13-board individual payload, yielding between raids so the
 *  synchronous queries don't monopolize the event loop in one burst. */
async function computeIndividualAll(hours: number, raidKeys: string[], filters?: LeaderboardFilters): Promise<Record<string, IndividualLeaderboard>> {
    const allRaids = getAllRaidDefinitions();
    const boards: Record<string, IndividualLeaderboard> = {};
    for (const raidKey of raidKeys) {
        boards[raidKey] = {
            raidKey,
            raidName: allRaids[raidKey]?.name || raidKey,
            entries: runLeaderboardRows(hours, [raidKey], CACHED_LIMIT, filters),
        };
        await yieldTick();
    }
    return boards;
}

// ── Envelope builders ────────────────────────────────────────────────────────

function aggregateBody(hours: number, raidKeys: string[], entries: LeaderboardResponseEntry[]): unknown {
    return { mode: 'aggregate', hours, fullClearsOnly: true, raidKeys, entries };
}

function individualBody(
    hours: number,
    raidKeys: string[],
    leaderboards: Record<string, IndividualLeaderboard>,
): unknown {
    return { mode: 'individual', hours, fullClearsOnly: true, raidKeys, leaderboards };
}

function sliceBoards(
    boards: Record<string, IndividualLeaderboard>,
    limit: number,
): Record<string, IndividualLeaderboard> {
    const out: Record<string, IndividualLeaderboard> = {};
    for (const [raidKey, board] of Object.entries(boards)) {
        out[raidKey] = { ...board, entries: board.entries.slice(0, limit) };
    }
    return out;
}

// ── Key normalization + entry point ──────────────────────────────────────────

function isFullSet(sortedKeys: string[], allKeys: string[]): boolean {
    if (sortedKeys.length !== allKeys.length) return false;
    const all = new Set(allKeys);
    return sortedKeys.every((k) => all.has(k));
}

function filterKeySuffix(filters?: LeaderboardFilters): string {
    if (!filters?.difficulty && filters?.exactPlayers == null && filters?.maxPlayers == null) return '';
    const parts: string[] = [];
    if (filters?.difficulty) parts.push(`d:${filters.difficulty}`);
    if (filters?.exactPlayers != null) parts.push(`ep:${filters.exactPlayers}`);
    if (filters?.maxPlayers != null) parts.push(`mp:${filters.maxPlayers}`);
    return `|${parts.join('|')}`;
}

/**
 * Resolve a request to a response body + cache state. Canonical shapes
 * (aggregate-all, individual-all, single-raid) are memoized via the SWR cache;
 * arbitrary multi-raid subsets bypass the cache and compute fresh.
 */
export async function getLeaderboardResponse(req: LeaderboardRequest): Promise<LeaderboardResult> {
    const allRaids = getAllRaidDefinitions();
    const allKeys = Object.keys(allRaids);
    const band = leaderboardCacheBand(req.hours);
    const swr = { freshMs: band.freshMs, staleMs: band.staleMs, negativeMs: band.negativeMs };

    const sortedSelected = [...req.raidKeys].sort();
    const isAll = sortedSelected.length === 0 || isFullSet(sortedSelected, allKeys);
    const cacheLimit = Math.min(req.limit, CACHED_LIMIT);
    const fSuffix = filterKeySuffix(req.filters);

    // Single raid — ranking is mode-agnostic; cache once, wrap per request mode.
    if (!isAll && sortedSelected.length === 1) {
        const raidKey = sortedSelected[0];
        const key = `single|${req.hours}|${raidKey}|fc1${fSuffix}`;
        const { value, state } = await getOrCompute(key, swr, () =>
            runLeaderboardRows(req.hours, [raidKey], CACHED_LIMIT, req.filters),
        );
        const entries = value.slice(0, cacheLimit);
        const body = req.mode === 'individual'
            ? individualBody(req.hours, [raidKey], {
                [raidKey]: { raidKey, raidName: allRaids[raidKey]?.name || raidKey, entries },
            })
            : aggregateBody(req.hours, [raidKey], entries);
        return { body, state, band };
    }

    // All raids — distinct computations per mode (cannot derive one from the other).
    if (isAll) {
        if (req.mode === 'individual') {
            const key = `individual|${req.hours}||fc1${fSuffix}`;
            const { value, state } = await getOrCompute(key, swr, () =>
                computeIndividualAll(req.hours, allKeys, req.filters),
            );
            return { body: individualBody(req.hours, allKeys, sliceBoards(value, cacheLimit)), state, band };
        }
        const key = `aggregate|${req.hours}||fc1${fSuffix}`;
        const { value, state } = await getOrCompute(key, swr, () =>
            runLeaderboardRows(req.hours, [], CACHED_LIMIT, req.filters),
        );
        return { body: aggregateBody(req.hours, allKeys, value.slice(0, cacheLimit)), state, band };
    }

    // Bypass — arbitrary subset (2..12 raids). Compute fresh at the requested limit.
    if (req.mode === 'individual') {
        const boards: Record<string, IndividualLeaderboard> = {};
        for (const raidKey of req.raidKeys) {
            boards[raidKey] = {
                raidKey,
                raidName: allRaids[raidKey]?.name || raidKey,
                entries: runLeaderboardRows(req.hours, [raidKey], req.limit, req.filters),
            };
        }
        return { body: individualBody(req.hours, req.raidKeys, boards), state: 'bypass', band };
    }

    const entries = runLeaderboardRows(req.hours, req.raidKeys, req.limit, req.filters);
    return { body: aggregateBody(req.hours, req.raidKeys, entries), state: 'bypass', band };
}
