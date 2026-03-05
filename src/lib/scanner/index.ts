import { BungieClient, BungieAPIError } from '../bungie/client';
import { RateLimiter } from '../utils/rate-limiter';
import { isRaidActivityHash, getRaidKeyFromHash } from '../bungie/manifest';
import { getDb } from '../db';
import { insertFullPGCR, hasPGCR } from '../db/queries';
import { isoToUnix } from '../utils/helpers';

// =====================
// CONFIGURATION
// =====================

export interface ScannerConfig {
    requestsPerSecond: number;
    batchSize: number;
    pauseOnCatchupMs: number;
    maxConsecutiveMisses: number;
    apiKey?: string;
    enabled: boolean;
}

const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
    requestsPerSecond: parseInt(process.env.SCANNER_REQUESTS_PER_SECOND || '20', 10),
    batchSize: parseInt(process.env.SCANNER_BATCH_SIZE || '50', 10),
    pauseOnCatchupMs: parseInt(process.env.SCANNER_PAUSE_ON_CATCHUP_MS || '10000', 10),
    maxConsecutiveMisses: parseInt(process.env.SCANNER_MAX_CONSECUTIVE_MISSES || '50', 10),
    apiKey: process.env.BUNGIE_SCANNER_API_KEY || undefined,
    enabled: true,
};

// =====================
// SCANNER STATE
// =====================

interface ScannerState {
    currentInstanceId: bigint;
    totalScanned: number;
    totalRaidsFound: number;
    totalMisses: number;
    consecutiveMisses: number;
    isRunning: boolean;
    shouldStop: boolean;
    startedAt: number;
}

let state: ScannerState = {
    currentInstanceId: BigInt(0),
    totalScanned: 0,
    totalRaidsFound: 0,
    totalMisses: 0,
    consecutiveMisses: 0,
    isRunning: false,
    shouldStop: false,
    startedAt: 0,
};

// Separate client and rate limiter for the scanner
let scannerClient: BungieClient | null = null;
let scannerRateLimiter: RateLimiter | null = null;

// =====================
// CLIENT SETUP
// =====================

function getScannerClient(config: ScannerConfig): BungieClient {
    if (!scannerClient) {
        const apiKey = config.apiKey || process.env.BUNGIE_API_KEY;
        if (!apiKey) {
            throw new Error('No API key available for scanner. Set BUNGIE_SCANNER_API_KEY or BUNGIE_API_KEY.');
        }

        scannerRateLimiter = new RateLimiter(config.requestsPerSecond);

        // Create a new BungieClient instance with the scanner's own key and rate limiter
        scannerClient = new BungieClient(apiKey, scannerRateLimiter);
    }
    return scannerClient;
}

// =====================
// STATE PERSISTENCE
// =====================

/**
 * Save the scanner's current position to the database so it can resume after restart.
 */
function saveScannerPosition(instanceId: bigint): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO crawler_state (key, value, updated_at)
    VALUES ('scanner_position', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = unixepoch()
  `).run(instanceId.toString());
}

/**
 * Load the scanner's last known position from the database.
 * Falls back to the highest instance ID in the pgcrs table.
 */
function loadScannerPosition(): bigint {
    const db = getDb();

    // First try the saved position
    const saved = db.prepare(
        "SELECT value FROM crawler_state WHERE key = 'scanner_position'"
    ).get() as { value: string } | undefined;

    if (saved && saved.value) {
        console.log(`[SCANNER] Resuming from saved position: ${saved.value}`);
        return BigInt(saved.value);
    }

    // Fall back to highest instance ID in the database
    const highest = db.prepare(
        'SELECT MAX(CAST(instance_id AS INTEGER)) as max_id FROM pgcrs'
    ).get() as { max_id: number | null } | undefined;

    if (highest?.max_id) {
        console.log(`[SCANNER] Starting from highest PGCR in database: ${highest.max_id}`);
        return BigInt(highest.max_id);
    }

    // If database is empty, we need a starting point
    // This is a recent instance ID — you may need to update this
    const fallback = BigInt('16795700000');
    console.log(`[SCANNER] No PGCRs in database. Starting from fallback: ${fallback}`);
    return fallback;
}

/**
 * Write scanner stats to the database for the web UI.
 */
function writeScannerStats(): void {
    const db = getDb();
    const stats = JSON.stringify({
        currentInstanceId: state.currentInstanceId.toString(),
        totalScanned: state.totalScanned,
        totalRaidsFound: state.totalRaidsFound,
        totalMisses: state.totalMisses,
        isRunning: state.isRunning,
        startedAt: state.startedAt,
        raidHitRate: state.totalScanned > 0
            ? ((state.totalRaidsFound / state.totalScanned) * 100).toFixed(2) + '%'
            : '0%',
        uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    });

    db.prepare(`
    INSERT INTO crawler_state (key, value, updated_at)
    VALUES ('scanner_stats', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = unixepoch()
  `).run(stats);
}

// =====================
// PGCR PROCESSING
// =====================

/**
 * Attempt to fetch and process a single PGCR by instance ID.
 * Returns: 'raid' | 'not_raid' | 'not_found' | 'error'
 */
async function scanSinglePGCR(
    client: BungieClient,
    instanceId: string
): Promise<'raid' | 'not_raid' | 'not_found' | 'error'> {
    // Skip if we already have it
    if (hasPGCR(instanceId)) {
        return 'not_raid'; // We already have it, treat as scanned
    }

    try {
        const response = await client.getPGCR(instanceId);
        const pgcrData = response.Response;

        if (!pgcrData || !pgcrData.activityDetails) {
            return 'not_found';
        }

        const activityHash = pgcrData.activityDetails.directorActivityHash
            || pgcrData.activityDetails.referenceId;

        // Check if this is a raid
        if (!isRaidActivityHash(activityHash)) {
            return 'not_raid';
        }

        // It's a raid! Process and store it.
        const raidKey = getRaidKeyFromHash(activityHash);

        const anyoneCompleted = pgcrData.entries?.some(
            (entry: any) => entry.values?.completed?.basic?.value === 1
        ) || false;

        const playerEntries = (pgcrData.entries || []).map((entry: any) => ({
            instanceId,
            membershipId: entry.player.destinyUserInfo.membershipId,
            membershipType: entry.player.destinyUserInfo.membershipType,
            displayName: entry.player.destinyUserInfo.displayName,
            bungieGlobalDisplayName: entry.player.destinyUserInfo.bungieGlobalDisplayName,
            characterClass: entry.player.characterClass || 'Unknown',
            lightLevel: entry.player.lightLevel || 0,
            completed: entry.values?.completed?.basic?.value === 1,
            kills: entry.values?.kills?.basic?.value || 0,
            deaths: entry.values?.deaths?.basic?.value || 0,
            assists: entry.values?.assists?.basic?.value || 0,
            timePlayedSeconds: entry.values?.timePlayedSeconds?.basic?.value || 0,
        }));

        insertFullPGCR(
            {
                instanceId,
                activityHash,
                raidKey,
                period: isoToUnix(pgcrData.period),
                startingPhaseIndex: pgcrData.startingPhaseIndex || 0,
                activityWasStartedFromBeginning: pgcrData.activityWasStartedFromBeginning || false,
                completed: anyoneCompleted,
                playerCount: (pgcrData.entries || []).length,
            },
            playerEntries
        );

        // Also add discovered players to the players table
        const db = getDb();
        const upsertPlayer = db.prepare(`
      INSERT INTO players (membership_id, membership_type, display_name, bungie_global_display_name, bungie_global_display_name_code, discovered_at, is_active)
      VALUES (?, ?, ?, ?, ?, unixepoch(), 1)
      ON CONFLICT(membership_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, players.display_name),
        bungie_global_display_name = COALESCE(excluded.bungie_global_display_name, players.bungie_global_display_name),
        bungie_global_display_name_code = COALESCE(excluded.bungie_global_display_name_code, players.bungie_global_display_name_code)
    `);

        const insertMany = db.transaction((entries: any[]) => {
            for (const entry of entries) {
                upsertPlayer.run(
                    entry.membershipId,
                    entry.membershipType,
                    entry.displayName,
                    entry.bungieGlobalDisplayName || null,
                    entry.bungieGlobalDisplayNameCode || null
                );
            }
        });

        insertMany(playerEntries);

        return 'raid';
    } catch (error) {
        if (error instanceof BungieAPIError) {
            // PGCR doesn't exist
            if (
                error.errorCode === 1653 || // DestinyPGCRNotFound
                error.errorStatus === 'DestinyPGCRNotFound' ||
                error.errorCode === 7 // ParameterParseFailure (invalid ID)
            ) {
                return 'not_found';
            }

            // System disabled — stop scanning temporarily
            if (error.errorStatus === 'SystemDisabled') {
                console.error('[SCANNER] Bungie API is disabled. Pausing...');
                return 'error';
            }
        }

        // Log unexpected errors but continue scanning
        console.error(`[SCANNER] Error fetching PGCR ${instanceId}:`, (error as Error).message);
        return 'error';
    }
}

// =====================
// SCAN LOOP
// =====================

/**
 * Scan a batch of sequential instance IDs.
 */
async function scanBatch(
    client: BungieClient,
    startId: bigint,
    batchSize: number
): Promise<{
    scanned: number;
    raidsFound: number;
    misses: number;
    consecutiveMisses: number;
    lastId: bigint;
}> {
    let raidsFound = 0;
    let misses = 0;
    let consecutiveMisses = 0;
    let scanned = 0;
    let currentId = startId;

    for (let i = 0; i < batchSize; i++) {
        if (state.shouldStop) break;

        currentId = startId + BigInt(i);
        const instanceId = currentId.toString();

        const result = await scanSinglePGCR(client, instanceId);
        scanned++;

        switch (result) {
            case 'raid':
                raidsFound++;
                consecutiveMisses = 0;
                break;
            case 'not_raid':
                consecutiveMisses = 0;
                break;
            case 'not_found':
                misses++;
                consecutiveMisses++;
                break;
            case 'error':
                consecutiveMisses++;
                break;
        }
    }

    return {
        scanned,
        raidsFound,
        misses,
        consecutiveMisses,
        lastId: currentId,
    };
}

// =====================
// PUBLIC API
// =====================

/**
 * Start the PGCR scanner.
 */
export async function startScanner(overrides?: Partial<ScannerConfig>): Promise<void> {
    const config = { ...DEFAULT_SCANNER_CONFIG, ...overrides };

    if (state.isRunning) {
        console.warn('[SCANNER] Scanner is already running');
        return;
    }

    if (!config.enabled) {
        console.log('[SCANNER] Scanner is disabled');
        return;
    }

    state.isRunning = true;
    state.shouldStop = false;
    state.startedAt = Date.now();
    state.totalScanned = 0;
    state.totalRaidsFound = 0;
    state.totalMisses = 0;

    const client = getScannerClient(config);
    state.currentInstanceId = loadScannerPosition();

    console.log('[SCANNER] Starting PGCR scanner');
    console.log(`  Rate limit:    ${config.requestsPerSecond} req/s`);
    console.log(`  Batch size:    ${config.batchSize}`);
    console.log(`  Catchup pause: ${config.pauseOnCatchupMs}ms`);
    console.log(`  Max misses:    ${config.maxConsecutiveMisses}`);
    console.log(`  Starting at:   ${state.currentInstanceId}`);
    console.log(`  API key:       ${config.apiKey ? 'dedicated scanner key' : 'shared main key'}`);
    console.log('');

    async function scanLoop() {
        if (state.shouldStop) {
            state.isRunning = false;
            saveScannerPosition(state.currentInstanceId);
            writeScannerStats();
            console.log('[SCANNER] Scanner stopped');
            return;
        }

        const batchStart = state.currentInstanceId + BigInt(1);

        const result = await scanBatch(client, batchStart, config.batchSize);

        state.totalScanned += result.scanned;
        state.totalRaidsFound += result.raidsFound;
        state.totalMisses += result.misses;
        state.consecutiveMisses = result.consecutiveMisses;
        state.currentInstanceId = result.lastId;

        // Save position every batch
        saveScannerPosition(state.currentInstanceId);

        // Log progress
        const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(0);
        const hitRate = state.totalScanned > 0
            ? ((state.totalRaidsFound / state.totalScanned) * 100).toFixed(1)
            : '0';

        if (result.raidsFound > 0) {
            console.log(
                `[SCANNER] Batch complete: ${result.raidsFound} raids found in ${result.scanned} PGCRs | ` +
                `Total: ${state.totalRaidsFound} raids / ${state.totalScanned} scanned (${hitRate}% hit rate) | ` +
                `Position: ${state.currentInstanceId} | ${elapsed}s elapsed`
            );
        }

        // Write stats periodically (every 5 batches)
        if (state.totalScanned % (config.batchSize * 5) === 0) {
            writeScannerStats();
        }

        // Check if we've caught up to the present (too many consecutive misses)
        if (state.consecutiveMisses >= config.maxConsecutiveMisses) {
            console.log(
                `[SCANNER] Caught up to present (${state.consecutiveMisses} consecutive misses). ` +
                `Pausing for ${config.pauseOnCatchupMs / 1000}s...`
            );
            state.consecutiveMisses = 0;
            writeScannerStats();
            setTimeout(scanLoop, config.pauseOnCatchupMs);
            return;
        }

        // Small delay between batches to avoid hammering
        setTimeout(scanLoop, 100);
    }

    scanLoop();
}

/**
 * Stop the scanner gracefully.
 */
export function stopScanner(): void {
    console.log('[SCANNER] Stopping scanner...');
    state.shouldStop = true;
}

/**
 * Check if the scanner is running.
 */
export function isScannerRunning(): boolean {
    return state.isRunning;
}

/**
 * Get current scanner stats.
 */
export function getScannerStats(): {
    isRunning: boolean;
    currentInstanceId: string;
    totalScanned: number;
    totalRaidsFound: number;
    hitRate: string;
    uptimeSeconds: number;
} {
    return {
        isRunning: state.isRunning,
        currentInstanceId: state.currentInstanceId.toString(),
        totalScanned: state.totalScanned,
        totalRaidsFound: state.totalRaidsFound,
        hitRate: state.totalScanned > 0
            ? ((state.totalRaidsFound / state.totalScanned) * 100).toFixed(2) + '%'
            : '0%',
        uptimeSeconds: state.isRunning ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
    };
}
