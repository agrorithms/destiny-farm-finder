import { BungieClient, BungieAPIError } from '../bungie/client';
import {
    isBungieSystemDisabledError,
    recordBungieMaintenancePause,
    waitForBungieMaintenancePause,
} from '../bungie/maintenance';
import { isRaidActivityHash, getRaidKeyFromHash } from '../bungie/manifest';
import { getDb } from '../db';
import { insertFullPGCR, hasPGCR } from '../db/queries';
import type { InsertFullPGCRPlayer } from '../db/queries';
import { readActivityDurationSeconds, readEntryStartSeconds } from '../bungie/pgcr-stats';
import { isoToUnix } from '../utils/helpers';

type RunnableStatement = {
    run: (...params: unknown[]) => unknown;
};

type ScannerPlayerEntry = InsertFullPGCRPlayer & {
    bungieGlobalDisplayNameCode?: number | null;
};

type ScannerRequestResult =
    | 'raid'
    | 'not_raid'
    | 'not_found'
    | 'error'
    | 'error_retryable'
    | 'system_disabled'
    | 'fatal_no_clients';

type ScannerClientSlot = {
    index: number;
    apiKeyLabel: string;
    client: BungieClient;
    disabled: boolean;
};

const VALID_MEMBERSHIP_TYPES = new Set([1, 2, 3, 5, 6]);
// Global set for missed IDs (deduped, capped)
const missedIdsSet = new Set<string>();
const RETRY_THRESHOLD = 50; // Retry when 50 missed IDs are collected
const MAX_MISSED_IDS = parseInt(process.env.SCANNER_MAX_MISSED_IDS || '20000', 10);
// Delay before re-entering the scan loop after an unexpected iteration error
// (e.g. transient SQLITE_BUSY) so the scanner rides out DB contention instead
// of crashing the process.
const SCAN_LOOP_ERROR_RETRY_MS = 5000;
let missedIdsDroppedDueToCap = 0;

function addMissedId(instanceId: string): void {
    if (missedIdsSet.has(instanceId)) {
        return;
    }

    if (missedIdsSet.size >= MAX_MISSED_IDS) {
        missedIdsDroppedDueToCap++;
        return;
    }

    missedIdsSet.add(instanceId);
}

function addMissedIds(instanceIds: string[]): void {
    for (const instanceId of instanceIds) {
        addMissedId(instanceId);
    }
}

function isValidMembershipType(type: unknown): boolean {
    return VALID_MEMBERSHIP_TYPES.has(Number(type));
}

// =====================
// CONFIGURATION
// =====================

export interface ScannerConfig {
    requestsPerSecond: number;
    batchSize: number;
    pauseOnCatchupMs: number;
    maxConsecutiveMisses: number;
    progressLogEvery: number;
    apiKeys?: string[];
    apiKey?: string;
    enabled: boolean;
    workers: number;
}

export function getScannerApiKeysFromEnv(): string[] {
    return [
        process.env.BUNGIE_SCANNER_API_KEY,
        process.env.BUNGIE_SCANNER_API_KEY_2,
        process.env.BUNGIE_SCANNER_API_KEY_3,
        process.env.BUNGIE_SCANNER_API_KEY_4,
    ]
        .map((key) => key?.trim())
        .filter((key): key is string => Boolean(key));
}

const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
    requestsPerSecond: parseInt(process.env.SCANNER_REQUESTS_PER_SECOND || '25', 10),
    batchSize: parseInt(process.env.SCANNER_BATCH_SIZE || '75', 10),
    pauseOnCatchupMs: parseInt(process.env.SCANNER_PAUSE_ON_CATCHUP_MS || '20000', 10),
    maxConsecutiveMisses: parseInt(process.env.SCANNER_MAX_CONSECUTIVE_MISSES || '50', 10),
    progressLogEvery: parseInt(process.env.SCANNER_PROGRESS_LOG_EVERY || '1000', 10),
    apiKeys: getScannerApiKeysFromEnv(),
    enabled: true,
    workers: parseInt(process.env.SCANNER_WORKERS || '15', 10),
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

const state: ScannerState = {
    currentInstanceId: BigInt(0),
    totalScanned: 0,
    totalRaidsFound: 0,
    totalMisses: 0,
    consecutiveMisses: 0,
    isRunning: false,
    shouldStop: false,
    startedAt: 0,
};

// Separate client pool and rate limiters for the scanner
let scannerClientPool: ScannerClientPool | null = null;
let scannerClientPoolSignature: string | null = null;
let scannerStmtDbRef: ReturnType<typeof getDb> | null = null;
let scannerUpsertPlayerStmt: RunnableStatement | null = null;
let scannerInsertManyPlayersTx: ((entries: ScannerPlayerEntry[]) => void) | null = null;

// =====================
// CLIENT SETUP
// =====================

function normalizeScannerApiKeys(config: ScannerConfig): string[] {
    const rawKeys = config.apiKeys && config.apiKeys.length > 0
        ? config.apiKeys
        : config.apiKey
            ? [config.apiKey]
            : getScannerApiKeysFromEnv();

    const normalized = rawKeys
        .map((key) => key.trim())
        .filter((key) => key.length > 0);

    return Array.from(new Set(normalized));
}

function getScannerClientPool(config: ScannerConfig): ScannerClientPool {
    const apiKeys = normalizeScannerApiKeys(config);

    if (apiKeys.length === 0) {
        throw new Error('No scanner API keys available. Set BUNGIE_SCANNER_API_KEY, _2, _3, or _4.');
    }

    const signature = `${config.requestsPerSecond}:${apiKeys.join('|')}`;

    if (!scannerClientPool || scannerClientPoolSignature !== signature) {
        scannerClientPool = new ScannerClientPool(apiKeys, config.requestsPerSecond);
        scannerClientPoolSignature = signature;
    }

    return scannerClientPool;
}

function getBungieApiHttpStatus(error: unknown): number | null {
    const message = (error as Error)?.message || '';
    const match = message.match(/Bungie API error (\d+):/i);
    if (!match) {
        return null;
    }

    const status = Number.parseInt(match[1], 10);
    return Number.isFinite(status) ? status : null;
}

function shouldDisableScannerClient(error: unknown): boolean {
    const status = getBungieApiHttpStatus(error);
    if (status === 401 || status === 403 || status === 429) {
        return true;
    }

    return false;
}

function describeScannerClientFailure(error: unknown): string {
    const status = getBungieApiHttpStatus(error);
    if (status) {
        return `HTTP ${status}`;
    }

    if (error instanceof Error && error.message) {
        return error.message;
    }

    return 'unknown error';
}

class ScannerClientPool {
    private slots: ScannerClientSlot[];
    private nextSlotIndex: number;
    private requestsPerSecond: number;

    constructor(apiKeys: string[], requestsPerSecond: number) {
        this.requestsPerSecond = requestsPerSecond;
        this.slots = apiKeys.map((apiKey, index) => ({
            index,
            apiKeyLabel: `key-${index + 1}`,
            client: new BungieClient(apiKey, requestsPerSecond),
            disabled: false,
        }));
        this.nextSlotIndex = 0;
    }

    get totalClients(): number {
        return this.slots.length;
    }

    get activeClients(): number {
        return this.slots.filter((slot) => !slot.disabled).length;
    }

    get totalRequestsPerSecond(): number {
        return this.activeClients * this.requestsPerSecond;
    }

    acquireClient(): ScannerClientSlot | null {
        if (this.activeClients === 0) {
            return null;
        }

        for (let i = 0; i < this.slots.length; i++) {
            const slotIndex = (this.nextSlotIndex + i) % this.slots.length;
            const slot = this.slots[slotIndex];
            if (slot.disabled) {
                continue;
            }

            this.nextSlotIndex = (slotIndex + 1) % this.slots.length;
            return slot;
        }

        return null;
    }

    disableClient(slotIndex: number, reason: string): void {
        const slot = this.slots[slotIndex];
        if (!slot || slot.disabled) {
            return;
        }

        slot.disabled = true;
        const remaining = this.activeClients;
        console.warn(
            `[SCANNER] Disabling ${slot.apiKeyLabel} after ${reason}. ` +
            `${remaining}/${this.totalClients} scanner keys remain active.`
        );
    }
}

function getScannerPlayerUpsertTransaction(): (entries: ScannerPlayerEntry[]) => void {
    const db = getDb();

    // Rebuild prepared statements if DB instance changes (for safety in long-lived runtimes).
    if (!scannerInsertManyPlayersTx || !scannerUpsertPlayerStmt || scannerStmtDbRef !== db) {
        scannerStmtDbRef = db;
        scannerUpsertPlayerStmt = db.prepare(`
      INSERT INTO players (membership_id, membership_type, display_name, bungie_global_display_name, bungie_global_display_name_code, discovered_at, is_active)
      VALUES (?, ?, ?, ?, ?, unixepoch(), 1)
      ON CONFLICT(membership_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, players.display_name),
        bungie_global_display_name = COALESCE(excluded.bungie_global_display_name, players.bungie_global_display_name),
        bungie_global_display_name_code = COALESCE(excluded.bungie_global_display_name_code, players.bungie_global_display_name_code)
    `) as unknown as RunnableStatement;

        scannerInsertManyPlayersTx = db.transaction((entries: ScannerPlayerEntry[]) => {
            for (const entry of entries) {
                if (!isValidMembershipType(entry.membershipType)) continue;
                scannerUpsertPlayerStmt!.run(
                    entry.membershipId,
                    entry.membershipType,
                    entry.displayName,
                    entry.bungieGlobalDisplayName || null,
                    entry.bungieGlobalDisplayNameCode || null
                );
            }
        });
    }

    return scannerInsertManyPlayersTx;
}

// =====================
// STATE PERSISTENCE
// =====================

function saveScannerPosition(instanceId: bigint): void {
    // Best-effort checkpoint: the live position stays in memory, so a save that
    // loses the busy-timeout race is just skipped — the next loop iteration
    // persists a newer position anyway (and re-scanned IDs are no-ops on insert).
    try {
        const db = getDb();

        const current = db.prepare(
            "SELECT value FROM crawler_state WHERE key = 'scanner_position'"
        ).get() as { value: string } | undefined;

        if (current && BigInt(current.value) > instanceId) {
            return;
        }

        db.prepare(`
        INSERT INTO crawler_state (key, value, updated_at)
        VALUES ('scanner_position', ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = unixepoch()
      `).run(instanceId.toString());
    } catch (error) {
        console.warn(`[SCANNER] Failed to save position ${instanceId} (will retry next cycle):`, error);
    }
}

function loadScannerPosition(): bigint {
    const db = getDb();

    const saved = db.prepare(
        "SELECT value FROM crawler_state WHERE key = 'scanner_position'"
    ).get() as { value: string } | undefined;

    if (saved && saved.value) {
        console.log(`[SCANNER] Resuming from saved position: ${saved.value}`);
        return BigInt(saved.value);
    }

    const highest = db.prepare(
        'SELECT MAX(CAST(instance_id AS INTEGER)) as max_id FROM pgcrs'
    ).get() as { max_id: number | null } | undefined;

    if (highest?.max_id) {
        console.log(`[SCANNER] Starting from highest PGCR in database: ${highest.max_id}`);
        return BigInt(highest.max_id);
    }

    const fallback = BigInt('16795700000');
    console.log(`[SCANNER] No PGCRs in database. Starting from fallback: ${fallback}`);
    return fallback;
}

function loadScannerPositionRaw(): bigint {
    const db = getDb();
    const saved = db.prepare(
        "SELECT value FROM crawler_state WHERE key = 'scanner_position'"
    ).get() as { value: string } | undefined;

    if (saved && saved.value) {
        return BigInt(saved.value);
    }
    return BigInt(0);
}

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

async function scanSinglePGCR(
    clientPool: ScannerClientPool,
    instanceId: string
): Promise<ScannerRequestResult> {
    if (hasPGCR(instanceId)) {
        return 'not_raid';
    }

    while (true) {
        const client = clientPool.acquireClient();
        if (!client) {
            return 'fatal_no_clients';
        }

        try {
            const response = await client.client.getPGCR(instanceId);
            const pgcrData = response.Response;

            if (!pgcrData || !pgcrData.activityDetails) {
                return 'not_found';
            }

            const activityHash = pgcrData.activityDetails.directorActivityHash
                || pgcrData.activityDetails.referenceId;

            if (!isRaidActivityHash(activityHash)) {
                return 'not_raid';
            }

            const raidKey = getRaidKeyFromHash(activityHash);

            const anyoneCompleted = pgcrData.entries?.some(
                (entry) => entry.values?.completed?.basic?.value === 1
            ) || false;

            const playerEntries: ScannerPlayerEntry[] = (pgcrData.entries || []).map((entry) => ({
                instanceId,
                membershipId: entry.player.destinyUserInfo.membershipId,
                membershipType: entry.player.destinyUserInfo.membershipType,
                displayName: entry.player.destinyUserInfo.displayName,
                bungieGlobalDisplayName: entry.player.destinyUserInfo.bungieGlobalDisplayName,
                bungieGlobalDisplayNameCode: entry.player.destinyUserInfo.bungieGlobalDisplayNameCode ?? null,
                characterClass: entry.player.characterClass || 'Unknown',
                lightLevel: entry.player.lightLevel || 0,
                completed: entry.values?.completed?.basic?.value === 1,
                kills: entry.values?.kills?.basic?.value || 0,
                deaths: entry.values?.deaths?.basic?.value || 0,
                assists: entry.values?.assists?.basic?.value || 0,
                timePlayedSeconds: entry.values?.timePlayedSeconds?.basic?.value || 0,
                startSeconds: readEntryStartSeconds(entry),
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
                    source: 'scanner',
                    activityDurationSeconds: readActivityDurationSeconds(pgcrData.entries),
                },
                playerEntries
            );

            const insertMany = getScannerPlayerUpsertTransaction();
            insertMany(playerEntries);

            return 'raid';
        } catch (error) {
            const errorMessage = (error as Error).message || '';

            if (shouldDisableScannerClient(error)) {
                clientPool.disableClient(client.index, describeScannerClientFailure(error));
                if (clientPool.activeClients === 0) {
                    return 'fatal_no_clients';
                }

                continue;
            }

            // Check for PGCR not found — whether it's a BungieAPIError or regular Error
            if (
                (error instanceof BungieAPIError && (
                    error.errorCode === 1653 ||
                    error.errorStatus === 'DestinyPGCRNotFound' ||
                    error.errorCode === 7
                )) ||
                errorMessage.includes('DestinyPGCRNotFound') ||
                errorMessage.includes('1653')
            ) {
                return 'not_found';
            }

            // System disabled
            if (isBungieSystemDisabledError(error)) {
                recordBungieMaintenancePause('scanner');
                return 'system_disabled';
            }

            // Detect Cloudflare/HTTP server errors (502, 503, 504)
            if (
                errorMessage.includes('502') ||
                errorMessage.includes('503') ||
                errorMessage.includes('504') ||
                errorMessage.includes('Bad gateway') ||
                errorMessage.includes('<!DOCTYPE html>')
            ) {
                console.warn(`[SCANNER] ⚠️ Bungie API server error for PGCR ${instanceId} — will retry`);
                return 'error_retryable';
            }

            // Log unexpected errors (truncated) but continue scanning
            console.error(`[SCANNER] Error fetching PGCR ${instanceId}:`, errorMessage.substring(0, 150));
            return 'error';
        }
    }
}

// =====================
// SCAN BATCH (CONCURRENT)
// =====================


async function scanBatch(
    clientPool: ScannerClientPool,
    startId: bigint,
    batchSize: number,
    workerCount: number
): Promise<{
    scanned: number;
    raidsFound: number;
    misses: number;
    consecutiveMisses: number;
    missedIdsAdded: number;
    missedIdsDropped: number;
    lastId: bigint;
    systemDisabled: boolean;
    fatalNoClients: boolean;
}> {
    let raidsFound = 0;
    let misses = 0;
    let scanned = 0;

    // Build the list of instance IDs for this batch
    const instanceIds: string[] = [];
    for (let i = 0; i < batchSize; i++) {
        instanceIds.push((startId + BigInt(i)).toString());
    }

    // Shared index — each worker grabs the next available ID
    let nextIndex = 0;
    let systemDisabled = false;
    let fatalNoClients = false;

    // Track results in order for consecutive miss calculation
    const results: Array<ScannerRequestResult | undefined> = new Array(batchSize);

    async function worker() {
        while (true) {
            if (systemDisabled || fatalNoClients) break;

            const myIndex = nextIndex++;
            if (myIndex >= batchSize || state.shouldStop || systemDisabled || fatalNoClients) break;

            const result = await scanSinglePGCR(clientPool, instanceIds[myIndex]);
            results[myIndex] = result;

            switch (result) {
                case 'raid':
                    raidsFound++;
                    scanned++;
                    break;
                case 'not_raid':
                    scanned++;
                    break;
                case 'not_found':
                    misses++;
                    scanned++;
                    break;
                case 'error':
                    scanned++;
                    break;
                case 'error_retryable':
                    break;
                case 'system_disabled':
                    systemDisabled = true;
                    break;
                case 'fatal_no_clients':
                    fatalNoClients = true;
                    break;
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(workerCount, batchSize) },
        () => worker()
    );
    await Promise.all(workers);

    // *** THIS IS THE KEY PART ***
    // Collect ALL IDs that were not_found or error_retryable for retry
    let addedThisBatch = 0;
    let droppedThisBatch = 0;
    for (let i = 0; i < results.length; i++) {
        if (results[i] === 'not_found' || results[i] === 'error_retryable') {
            const sizeBefore = missedIdsSet.size;
            const droppedBefore = missedIdsDroppedDueToCap;
            addMissedId(instanceIds[i]);
            if (missedIdsSet.size > sizeBefore) addedThisBatch++;
            if (missedIdsDroppedDueToCap > droppedBefore) droppedThisBatch++;
        }
    }
    // Calculate consecutive misses from the END of the batch
    let consecutiveMisses = 0;
    for (let i = results.length - 1; i >= 0; i--) {
        if (results[i] === 'not_found' || results[i] === 'error') {
            consecutiveMisses++;
        } else {
            break;
        }
    }

    const lastId = fatalNoClients
        ? startId - BigInt(1)
        : startId + BigInt(batchSize - 1);

    return {
        scanned,
        raidsFound,
        misses,
        consecutiveMisses,
        missedIdsAdded: addedThisBatch,
        missedIdsDropped: droppedThisBatch,
        lastId,
        systemDisabled,
        fatalNoClients,
    };
}


// =====================
// RETRY MISSED IDs
// =====================

async function retryMissedIds(
    clientPool: ScannerClientPool,
    missedIds: string[],
    workerCount: number
): Promise<{ retryRaidsFound: number; stillMissing: number; stillMissingIds: string[]; systemDisabled: boolean; fatalNoClients: boolean }> {
    let retryRaidsFound = 0;
    let stillMissing = 0;
    let nextIndex = 0;
    let systemDisabled = false;
    let fatalNoClients = false;
    const stillMissingIds: string[] = [];

    async function worker() {
        while (true) {
            if (systemDisabled || fatalNoClients) break;

            const myIndex = nextIndex++;
            if (myIndex >= missedIds.length || state.shouldStop || systemDisabled || fatalNoClients) break;

            const result = await scanSinglePGCR(clientPool, missedIds[myIndex]);

            switch (result) {
                case 'raid':
                    retryRaidsFound++;
                    // Successfully found — do NOT put back in queue
                    break;
                case 'not_raid':
                    // Exists but isn't a raid — do NOT put back in queue
                    break;
                case 'not_found':
                case 'error':
                case 'error_retryable':
                    stillMissing++;
                    stillMissingIds.push(missedIds[myIndex]);
                    break;
                case 'system_disabled':
                    systemDisabled = true;
                    stillMissing++;
                    stillMissingIds.push(missedIds[myIndex]);
                    break;
                case 'fatal_no_clients':
                    fatalNoClients = true;
                    stillMissing++;
                    stillMissingIds.push(missedIds[myIndex]);
                    break;
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(workerCount, missedIds.length) },
        () => worker()
    );
    await Promise.all(workers);

    return { retryRaidsFound, stillMissing, stillMissingIds, systemDisabled, fatalNoClients };
}


// =====================
// PUBLIC API
// =====================

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

    scannerClientPool = null;
    scannerClientPoolSignature = null;
    const clientPool = getScannerClientPool(config);
    state.currentInstanceId = loadScannerPosition();
    state.isRunning = true;
    state.shouldStop = false;
    state.startedAt = Date.now();
    state.totalScanned = 0;
    state.totalRaidsFound = 0;
    state.totalMisses = 0;

    console.log('[SCANNER] Starting PGCR scanner');
    console.log(`  API keys:      ${clientPool.totalClients} configured / ${clientPool.activeClients} active`);
    console.log(`  Rate limit:    ${config.requestsPerSecond} req/s per key`);
    console.log(`  Effective:     ${clientPool.totalRequestsPerSecond} req/s total`);
    console.log(`  Batch size:    ${config.batchSize}`);
    console.log(`  Workers:       ${config.workers}`);
    console.log(`  Catchup pause: ${config.pauseOnCatchupMs}ms`);
    console.log(`  Max misses:    ${config.maxConsecutiveMisses}`);
    console.log(`  Progress log:  every ${config.progressLogEvery} scanned`);
    console.log(`  Starting at:   ${state.currentInstanceId}`);
    console.log('');

    // Guard around each iteration: an unexpected error (transient SQLITE_BUSY
    // past the busy_timeout, disk hiccup, …) logs and re-schedules instead of
    // crashing the process via an unhandled rejection.
    async function scanLoop() {
        try {
            await scanLoopIteration();
        } catch (error) {
            console.error(
                `[SCANNER] Scan loop iteration failed; retrying in ${SCAN_LOOP_ERROR_RETRY_MS / 1000}s:`,
                error
            );
            setTimeout(scanLoop, SCAN_LOOP_ERROR_RETRY_MS);
        }
    }

    async function scanLoopIteration() {
        if (state.shouldStop) {
            state.isRunning = false;
            saveScannerPosition(state.currentInstanceId);
            writeScannerStats();
            console.log('[SCANNER] 🛑 Scanner stopped');
            return;
        }

        const resumedAfterMaintenance = await waitForBungieMaintenancePause('scanner', () => state.shouldStop);
        if (state.shouldStop) {
            scanLoop();
            return;
        }
        if (resumedAfterMaintenance) {
            console.log('[SCANNER] Resuming scan loop after Bungie maintenance pause.');
        }

        // Check if another process has moved the position ahead
        const dbPosition = loadScannerPositionRaw();
        if (dbPosition > state.currentInstanceId) {
            const jump = dbPosition - state.currentInstanceId;
            console.log(
                `[SCANNER] 🚀 Position jump detected! ${state.currentInstanceId} → ${dbPosition} (+${jump} IDs)`
            );
            console.log(`[SCANNER] 📡 Another process updated the position. Jumping ahead...`);
            state.currentInstanceId = dbPosition;
        }

        const batchStart = state.currentInstanceId + BigInt(1);
        const result = await scanBatch(clientPool, batchStart, config.batchSize, config.workers);
        const previousTotalScanned = state.totalScanned;

        if (result.systemDisabled) {
            state.totalScanned += result.scanned;
            state.totalRaidsFound += result.raidsFound;
            state.totalMisses += result.misses;
            state.consecutiveMisses = 0;
            writeScannerStats();

            await waitForBungieMaintenancePause('scanner', () => state.shouldStop);
            setTimeout(scanLoop, 100);
            return;
        }

        if (result.fatalNoClients) {
            state.totalScanned += result.scanned;
            state.totalRaidsFound += result.raidsFound;
            state.totalMisses += result.misses;
            writeScannerStats();
            console.error('[SCANNER] All scanner API keys are disabled or unavailable. Stopping scanner until keys are fixed.');
            state.isRunning = false;
            saveScannerPosition(state.currentInstanceId);
            return;
        }

        state.totalScanned += result.scanned;
        state.totalRaidsFound += result.raidsFound;
        state.totalMisses += result.misses;
        state.consecutiveMisses = result.consecutiveMisses;
        state.currentInstanceId = result.lastId;

        saveScannerPosition(state.currentInstanceId);

        // Log periodic progress
        const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(0);
        const hitRate = state.totalScanned > 0
            ? ((state.totalRaidsFound / state.totalScanned) * 100).toFixed(1)
            : '0';
        const progressLogEvery =
            Number.isFinite(config.progressLogEvery) && config.progressLogEvery > 0
                ? config.progressLogEvery
                : 1000;
        const crossedProgressBoundary =
            Math.floor(previousTotalScanned / progressLogEvery) <
            Math.floor(state.totalScanned / progressLogEvery);

        if (crossedProgressBoundary) {
            console.log(
                `[SCANNER] Progress: ${state.totalRaidsFound} raids / ${state.totalScanned} scanned (${hitRate}% hit rate) | ` +
                `Missed queue: ${missedIdsSet.size}` +
                `${result.missedIdsAdded > 0 ? ` (+${result.missedIdsAdded} this batch)` : ''}` +
                `${result.missedIdsDropped > 0 ? `, +${result.missedIdsDropped} dropped (cap)` : ''} | ` +
                `Position: ${state.currentInstanceId} | ${elapsed}s elapsed`
            );
        }

        if (state.totalScanned % (config.batchSize * 5) === 0) {
            writeScannerStats();
        }

        // Caught up to present — pause then retry missed IDs
        if (state.consecutiveMisses >= config.maxConsecutiveMisses) {
            console.log(
                `[SCANNER] Caught up to present (${state.consecutiveMisses} consecutive misses). ` +
                `${missedIdsSet.size} missed IDs to retry. ` +
                `Pausing for ${config.pauseOnCatchupMs / 1000}s...`
            );
            state.consecutiveMisses = 0;
            writeScannerStats();

            // Pause, then retry missed IDs. The callback runs outside the
            // guarded iteration, so it needs its own error guard.
            setTimeout(async () => {
                try {
                    if (missedIdsSet.size >= RETRY_THRESHOLD) {
                        console.log(`[SCANNER] 🔄 Missed IDs set reached ${missedIdsSet.size}. Retrying...`);
                        const idsToRetry = Array.from(missedIdsSet);
                        missedIdsSet.clear();
                        const retryResult = await retryMissedIds(clientPool, idsToRetry, config.workers);

                        state.totalRaidsFound += retryResult.retryRaidsFound;
                        addMissedIds(retryResult.stillMissingIds);

                        console.log(
                            `[SCANNER] 🔄 Retry complete: ${retryResult.retryRaidsFound} raids found. ` +
                            `${retryResult.stillMissing} still missing. Set size: ${missedIdsSet.size}` +
                                `${missedIdsDroppedDueToCap > 0 ? ` (${missedIdsDroppedDueToCap} total dropped due to cap)` : ''}`
                        );

                        if (retryResult.systemDisabled) {
                            await waitForBungieMaintenancePause('scanner', () => state.shouldStop);
                        }

                        if (retryResult.fatalNoClients) {
                            console.error('[SCANNER] All scanner API keys were disabled during retry processing.');
                            state.isRunning = false;
                            saveScannerPosition(state.currentInstanceId);
                            writeScannerStats();
                            return;
                        }
                    }
                } catch (error) {
                    console.error('[SCANNER] Missed-ID retry pass failed; resuming scan loop:', error);
                }

                scanLoop();
            }, config.pauseOnCatchupMs);
            return;
        }

        // Small delay between batches
        setTimeout(scanLoop, 100);
    }

    scanLoop();
}

export function stopScanner(): void {
    console.log('[SCANNER] Stopping scanner...');
    state.shouldStop = true;
}

export function isScannerRunning(): boolean {
    return state.isRunning;
}

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
