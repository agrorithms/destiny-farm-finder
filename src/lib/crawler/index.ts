import {
    getPlayersForSessionPolling,
    bulkUpsertPlayers,
    deleteExpiredPGCRBatch,
    getDbStats,
    getDbStatsLite,
    drainCrawlQueue,
    deleteCrawlQueueRows,
    getPlayersInRecentBucket,
    getPlayersInColdBucket,
    recordSessionSnapshot,
} from '../db/queries';
import { crawlPlayer } from './players';
import { pollActiveSessions, resolveUnknownPartyMembers, collectPartyMemberIds } from './active-sessions';
import { getDb } from '../db';
import { processWithConcurrency } from '../utils/concurrent';
import {
    isBungieSystemDisabledError,
    recordBungieMaintenancePause,
    waitForBungieMaintenancePause,
} from '../bungie/maintenance';
import type { PlayerInfo } from '../bungie/types';

function writeCrawlerHeartbeat(): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO crawler_state (key, value, updated_at)
    VALUES ('heartbeat', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = unixepoch()
  `).run(new Date().toISOString());
}

function writeCrawlerStatus(status: string): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO crawler_state (key, value, updated_at)
    VALUES ('status', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = unixepoch()
  `).run(status);
}

// Written only when an active-session poll *completes* within its watchdog budget.
// Anchoring the heartbeat to completion (not start) means a stale value proves polls
// aren't finishing — the exact pathology — even while the watchdog keeps restarting
// the loop. Consumed by getCrawlerStatus → /api/status health verdict + admin stats.
function writeSessionHeartbeat(): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO crawler_state (key, value, updated_at)
    VALUES ('session_heartbeat', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = unixepoch()
  `).run(new Date().toISOString());
}

// Monotonic counter of watchdog trips (a poll abandoned for exceeding its time budget).
// The postmortem breadcrumb: a jump here means Bungie requests are hanging past their
// fetch timeout. value is TEXT, so increment via CAST.
function incrementSessionWatchdogTrips(): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO crawler_state (key, value, updated_at)
    VALUES ('session_watchdog_trips', '1', unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
      updated_at = unixepoch()
  `).run();
}

export interface CrawlerConfig {
    intervalMs: number;
    maxPlayersPerCycle: number;
    crawlConcurrency: number;
    enableActiveSessionPolling: boolean;
    activeSessionIntervalMs: number;
    activeSessionConcurrency: number;
    activeSessionStaleConcurrency: number;
    activeSessionStaleReverifyLimit: number;
    sessionPollingLimit: number;
    cleanupIntervalMs: number;
    cleanupMaxAgeHours: number;
    cleanupBatchSize: number;
    cleanupYieldMs: number;
    // DB-bounded pagination
    maxBackfillHours: number;
    hotRecrawlCount: number;
    coldCrawlCount: number;
    maxPages: number;
    charIdTtlDays: number;
    recrawlBufferSeconds: number;
    // Tiered bucket percentages
    bucketHotHours: number;
    bucketWarmHours: number;
    bucketHotPct: number;
    bucketWarmPct: number;
    bucketColdPct: number;
    // Crawl queue
    queueMaxPerCycle: number;
}

const DEFAULT_CONFIG: CrawlerConfig = {
    intervalMs: parseInt(process.env.CRAWLER_INTERVAL_MS || '90000', 10),
    maxPlayersPerCycle: parseInt(process.env.CRAWLER_MAX_PLAYERS_PER_CYCLE || '50', 10),
    crawlConcurrency: parseInt(process.env.CRAWLER_CONCURRENCY || '5', 10),
    enableActiveSessionPolling: true,
    activeSessionIntervalMs: parseInt(process.env.CRAWLER_ACTIVE_SESSION_INTERVAL_MS || '120000', 10), // 2 minutes
    activeSessionConcurrency: Math.max(
        1,
        parseInt(process.env.ACTIVE_SESSION_CONCURRENCY || process.env.CRAWLER_CONCURRENCY || '4', 10)
    ),
    activeSessionStaleConcurrency: Math.max(
        1,
        parseInt(
            process.env.ACTIVE_SESSION_STALE_CONCURRENCY
            || process.env.ACTIVE_SESSION_CONCURRENCY
            || process.env.CRAWLER_CONCURRENCY
            || '4',
            10
        )
    ),
    activeSessionStaleReverifyLimit: Math.max(
        1,
        parseInt(process.env.ACTIVE_SESSION_STALE_REVERIFY_LIMIT || '200', 10)
    ),
    sessionPollingLimit: Math.max(
        1,
        parseInt(process.env.CRAWLER_SESSION_POLLING_LIMIT || '200', 10)
    ),
    cleanupIntervalMs: 1800000, // 30 minutes
    cleanupMaxAgeHours: parseInt(process.env.CRAWLER_CLEANUP_MAX_AGE_HOURS || '720', 10),
    // 500 keeps the per-batch write-lock hold sub-second even on cold-cache dev disks
    // (2000 measured at 2-4s/batch on WSL2); prod steady state is ~4 batches per run.
    cleanupBatchSize: Math.max(1, parseInt(process.env.CRAWLER_CLEANUP_BATCH_SIZE || '500', 10)),
    cleanupYieldMs: Math.max(0, parseInt(process.env.CRAWLER_CLEANUP_YIELD_MS || '25', 10)),
    // DB-bounded pagination
    maxBackfillHours: parseInt(process.env.CRAWLER_BACKFILL_MAX_HOURS || '720', 10),
    hotRecrawlCount: parseInt(process.env.CRAWLER_HOT_RECRAWL_COUNT || '15', 10),
    coldCrawlCount: parseInt(process.env.CRAWLER_COLD_CRAWL_COUNT || '50', 10),
    maxPages: parseInt(process.env.CRAWLER_MAX_PAGES || '5', 10),
    charIdTtlDays: parseInt(process.env.CRAWLER_CHARACTER_IDS_TTL_DAYS || '14', 10),
    recrawlBufferSeconds: Math.max(0, parseInt(process.env.CRAWLER_RECRAWL_BUFFER_MINUTES || '30', 10)) * 60,
    // Tiered bucket percentages
    bucketHotHours: parseInt(process.env.CRAWLER_BUCKET_HOT_HOURS || '6', 10),
    bucketWarmHours: parseInt(process.env.CRAWLER_BUCKET_WARM_HOURS || '48', 10),
    bucketHotPct: parseInt(process.env.CRAWLER_BUCKET_HOT_PCT || '75', 10),
    bucketWarmPct: parseInt(process.env.CRAWLER_BUCKET_WARM_PCT || '15', 10),
    bucketColdPct: parseInt(process.env.CRAWLER_BUCKET_COLD_PCT || '10', 10),
    // Crawl queue
    queueMaxPerCycle: parseInt(process.env.CRAWLER_QUEUE_MAX_PER_CYCLE || '100', 10),
};

let isRunning = false;
let shouldStop = false;
const activeSessionInitialDelayMs = parseInt(process.env.CRAWLER_ACTIVE_SESSION_INITIAL_DELAY_MS || '30000', 10);

// Hard ceiling on a single active-session poll. A rare Bungie request can hang past its
// own fetch timeout with no backstop; without this, one hung request parks the whole
// session loop indefinitely (observed: overnight stalls) while the PGCR crawler keeps
// running. On expiry we abandon the in-flight poll and reschedule — the orphaned work is
// left to settle (Option A). Comfortably above a healthy poll (~3.5 min) to avoid killing
// legitimately-slow-but-progressing cycles and stacking overlapping polls.
const activeSessionPollWatchdogMs = Math.max(
    1000,
    parseInt(process.env.ACTIVE_SESSION_POLL_WATCHDOG_MS || '600000', 10) // 10 minutes
);

// Sentinel used to distinguish a watchdog expiry from a genuine poll error in the catch.
class PollWatchdogError extends Error {
    constructor(ms: number) {
        super(`Active session poll exceeded watchdog budget (${ms}ms)`);
        this.name = 'PollWatchdogError';
    }
}

interface CrawlTask {
    player: PlayerInfo;
    /** Activities per page — hot/queue players get a smaller, cheaper count. */
    pageCount: number;
}

/**
 * Run a single crawl cycle:
 * 1. Drain crawl_queue (additional budget, capped).
 * 2. Fill remaining budget with tiered buckets (hot 75% / warm 15% / cold 10%),
 *    with spillover when a bucket is thin.
 * 3. Crawl all players concurrently.
 * 4. Clean up processed queue rows.
 */
async function crawlCycle(config: CrawlerConfig): Promise<{
    playersCrawled: number;
    newPGCRs: number;
    newPlayersDiscovered: number;
}> {
    const now = Math.floor(Date.now() / 1000);
    const charIdTtlSeconds = config.charIdTtlDays * 24 * 60 * 60;
    const crawlOptions = {
        maxBackfillHours: config.maxBackfillHours,
        maxPages: config.maxPages,
        charIdTtlSeconds,
        recrawlBufferSeconds: config.recrawlBufferSeconds,
    };

    // --- Step 1: Drain crawl_queue (additional, capped) ---
    const queueRows = drainCrawlQueue(config.queueMaxPerCycle);
    const queueIds = new Set(queueRows.map((r) => r.membershipId));
    const queueTasks: CrawlTask[] = queueRows.map((r) => ({
        player: {
            membershipId: r.membershipId,
            membershipType: r.membershipType,
            displayName: r.displayName ?? r.membershipId,
        },
        pageCount: config.hotRecrawlCount, // recently ended session — fast check
    }));

    if (queueTasks.length > 0) {
        console.log(`[CRAWLER] Draining ${queueTasks.length} players from crawl_queue`);
    }

    // --- Step 2: Select tiered bucket players ---
    const total = config.maxPlayersPerCycle;
    const hotTarget = Math.floor(total * config.bucketHotPct / 100);
    const warmTarget = Math.floor(total * config.bucketWarmPct / 100);
    const coldTarget = total - hotTarget - warmTarget; // absorbs rounding

    const hotCutoff = now - config.bucketHotHours * 3600;
    const warmCutoff = now - config.bucketWarmHours * 3600;
    const excludeFromBuckets = [...queueIds];

    const hotPlayers = getPlayersInRecentBucket(hotCutoff, null, hotTarget, excludeFromBuckets);
    const hotIds = hotPlayers.map((p) => p.membershipId);

    const warmPlayers = getPlayersInRecentBucket(
        warmCutoff,
        hotCutoff,
        warmTarget,
        [...excludeFromBuckets, ...hotIds]
    );
    const warmIds = warmPlayers.map((p) => p.membershipId);

    const coldPlayers = getPlayersInColdBucket(
        warmCutoff,
        coldTarget,
        [...excludeFromBuckets, ...hotIds, ...warmIds]
    );

    // Spillover: redistribute unused budget hot→warm→cold
    const hotShortfall = hotTarget - hotPlayers.length;
    const warmShortfall = warmTarget - warmPlayers.length;

    if (hotShortfall > 0) {
        // Pull extra warm players to cover hot shortfall
        const extra = getPlayersInRecentBucket(
            warmCutoff,
            hotCutoff,
            hotShortfall,
            [...excludeFromBuckets, ...hotIds, ...warmIds]
        );
        warmPlayers.push(...extra);
        warmIds.push(...extra.map((p) => p.membershipId));

        // If warm couldn't cover it either, pull from cold
        const stillShort = hotShortfall - extra.length;
        if (stillShort > 0) {
            const coldExtra = getPlayersInColdBucket(
                warmCutoff,
                stillShort,
                [...excludeFromBuckets, ...hotIds, ...warmIds, ...coldPlayers.map((p) => p.membershipId)]
            );
            coldPlayers.push(...coldExtra);
        }
    }

    if (warmShortfall > 0) {
        const coldExtra = getPlayersInColdBucket(
            warmCutoff,
            warmShortfall,
            [...excludeFromBuckets, ...hotIds, ...warmIds, ...coldPlayers.map((p) => p.membershipId)]
        );
        coldPlayers.push(...coldExtra);
    }

    console.log(
        `[CRAWLER] Bucket selection: ${hotPlayers.length} hot / ${warmPlayers.length} warm / ${coldPlayers.length} cold` +
        (queueTasks.length > 0 ? ` + ${queueTasks.length} queued` : '')
    );

    // Build task list: queue first, then buckets
    const bucketTasks: CrawlTask[] = [
        ...hotPlayers.map((p) => ({ player: p, pageCount: config.hotRecrawlCount })),
        ...warmPlayers.map((p) => ({ player: p, pageCount: config.coldCrawlCount })),
        ...coldPlayers.map((p) => ({ player: p, pageCount: config.coldCrawlCount })),
    ];

    const allTasks: CrawlTask[] = [...queueTasks, ...bucketTasks];

    if (allTasks.length === 0) {
        console.log('⚠️ No players to crawl. Run the discovery tool first to seed players.');
        return { playersCrawled: 0, newPGCRs: 0, newPlayersDiscovered: 0 };
    }

    // --- Step 3: Crawl all tasks ---
    let totalNewPGCRs = 0;
    const discoveredFlushSize = Math.max(
        1,
        parseInt(process.env.CRAWLER_DISCOVERED_PLAYERS_FLUSH_SIZE || '500', 10)
    );
    const discoveredPlayersBuffer: PlayerInfo[] = [];
    let totalNewPlayersDiscovered = 0;
    let crawledCount = 0;
    let maintenanceDetected = false;
    const halfMilestone = Math.max(1, Math.floor(allTasks.length / 2));
    const fullMilestone = allTasks.length;
    const reachedMilestones = new Set<number>();

    await processWithConcurrency(
        allTasks,
        config.crawlConcurrency,
        async (task) => {
            if (shouldStop || maintenanceDetected) {
                return { newPGCRs: 0, discoveredPlayers: [] as PlayerInfo[], skipped: true };
            }
            const result = await crawlPlayer(task.player, {
                ...crawlOptions,
                pageCount: task.pageCount,
            });
            return { ...result, skipped: false };
        },
        (completed, total) => {
            const milestones = [
                Math.min(halfMilestone, total),
                Math.min(fullMilestone, total),
            ];

            for (const milestone of milestones) {
                if (completed >= milestone && !reachedMilestones.has(milestone)) {
                    reachedMilestones.add(milestone);
                    console.log(`[CRAWLER] Progress: ${completed}/${total} players`);
                }
            }

            if (completed === total && !reachedMilestones.has(total)) {
                reachedMilestones.add(total);
                console.log(`[CRAWLER] Progress: ${completed}/${total} players`);
            }
        },
        {
            collectResults: false,
            onResult: (result) => {
                if (!result.success) {
                    if (isBungieSystemDisabledError(result.error) && !maintenanceDetected) {
                        maintenanceDetected = true;
                        recordBungieMaintenancePause('crawler');
                    }
                    return;
                }
                if (result.result.skipped) return;

                crawledCount++;
                totalNewPGCRs += result.result.newPGCRs;
                if (result.result.discoveredPlayers.length > 0) {
                    totalNewPlayersDiscovered += result.result.discoveredPlayers.length;
                    discoveredPlayersBuffer.push(...result.result.discoveredPlayers);

                    if (discoveredPlayersBuffer.length >= discoveredFlushSize) {
                        bulkUpsertPlayers(discoveredPlayersBuffer);
                        discoveredPlayersBuffer.length = 0;
                    }
                }
            },
        }
    );

    // --- Step 4: Clean up queue rows ---
    if (queueIds.size > 0) {
        deleteCrawlQueueRows([...queueIds]);
    }

    // Flush any remaining discovered players
    if (discoveredPlayersBuffer.length > 0) {
        bulkUpsertPlayers(discoveredPlayersBuffer);
        discoveredPlayersBuffer.length = 0;
    }

    if (maintenanceDetected) {
        throw new Error('Bungie maintenance pause requested');
    }

    return {
        playersCrawled: crawledCount,
        newPGCRs: totalNewPGCRs,
        newPlayersDiscovered: totalNewPlayersDiscovered,
    };
}

/**
 * Start the main crawler loop using recursive setTimeout
 */
export async function startCrawler(overrides?: Partial<CrawlerConfig>): Promise<void> {
    const config = { ...DEFAULT_CONFIG, ...overrides };

    if (isRunning) {
        console.warn('⚠️ Crawler is already running');
        return;
    }

    isRunning = true;
    shouldStop = false;
    writeCrawlerStatus('running');
    writeCrawlerHeartbeat();

    console.log('🚀 Starting crawler with config:', {
        intervalMs: config.intervalMs,
        maxPlayersPerCycle: config.maxPlayersPerCycle,
        crawlConcurrency: config.crawlConcurrency,
        buckets: `${config.bucketHotPct}% hot(<${config.bucketHotHours}h) / ${config.bucketWarmPct}% warm(<${config.bucketWarmHours}h) / ${config.bucketColdPct}% cold`,
        queueMaxPerCycle: config.queueMaxPerCycle,
        pageCounts: `hot=${config.hotRecrawlCount} cold=${config.coldCrawlCount} maxPages=${config.maxPages}`,
        maxBackfillHours: config.maxBackfillHours,
        charIdTtlDays: config.charIdTtlDays,
        recrawlBufferMin: config.recrawlBufferSeconds / 60,
        activeSessionIntervalMs: config.activeSessionIntervalMs,
        activeSessionConcurrency: config.activeSessionConcurrency,
        activeSessionStaleConcurrency: config.activeSessionStaleConcurrency,
        activeSessionStaleReverifyLimit: config.activeSessionStaleReverifyLimit,
        sessionPollingLimit: config.sessionPollingLimit,
    });

    // Print initial stats
    const stats = getDbStats();
    console.log('📊 Database stats:', stats);

    // Main crawl loop
    async function crawlLoop() {
        if (shouldStop) {
            isRunning = false;
            writeCrawlerStatus('stopped');
            console.log('[CRAWLER] Crawler stopped');
            return;
        }

        const startTime = Date.now();
        const resumedAfterMaintenance = await waitForBungieMaintenancePause('crawler', () => shouldStop);
        if (shouldStop) {
            crawlLoop();
            return;
        }
        if (resumedAfterMaintenance) {
            console.log('[CRAWLER] Resuming crawl loop after Bungie maintenance pause.');
        }

        writeCrawlerHeartbeat();
        writeCrawlerStatus('running');
        console.log(`\n🔄 Starting crawl cycle at ${new Date().toISOString()}`);

        try {
            const result = await crawlCycle(config);
            console.log(
                `📈 Crawl cycle complete: ${result.playersCrawled} players crawled, ` +
                `${result.newPGCRs} new PGCRs, ${result.newPlayersDiscovered} new players`
            );
        } catch (error) {
            if (isBungieSystemDisabledError(error)) {
                recordBungieMaintenancePause('crawler');
                await waitForBungieMaintenancePause('crawler', () => shouldStop);
            } else if ((error as Error).message === 'Bungie maintenance pause requested') {
                await waitForBungieMaintenancePause('crawler', () => shouldStop);
            } else {
                console.error('❌ Crawl cycle error:', error);
            }
        }

        const elapsed = Date.now() - startTime;
        const waitTime = Math.max(0, config.intervalMs - elapsed);

        console.log(`⏱️ Cycle took ${(elapsed / 1000).toFixed(1)}s, waiting ${(waitTime / 1000).toFixed(1)}s`);

        setTimeout(crawlLoop, waitTime);
    }

    // Active session polling loop (separate interval).
    //
    // Reschedule lives in `finally`, guarded by shouldStop/enable, so the loop can never
    // die silently: no matter what throws — including the watchdog, a DB error, or the
    // maintenance-wait itself (now inside the try) — the next poll is always scheduled.
    // Exactly one reschedule per live iteration. The top-of-function return is the only
    // path that skips `finally` (clean stop → no reschedule).
    async function activeSessionLoop() {
        if (shouldStop || !config.enableActiveSessionPolling) return;

        const startTime = Date.now();
        let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

        try {
            // Single maintenance-wait location. If it throws, `catch` handles it and
            // `finally` still reschedules (previously this sat outside the try — the
            // silent-death path).
            const resumedAfterMaintenance = await waitForBungieMaintenancePause('active session poll', () => shouldStop);
            if (shouldStop || !config.enableActiveSessionPolling) return;
            if (resumedAfterMaintenance) {
                console.log('[SESSIONS] Resuming active session polling after Bungie maintenance pause.');
            }

            console.log(`\n👁️ Polling active sessions...`);

            // The whole poll body (candidate checks + stale re-verify + member resolution)
            // races the watchdog. If a single hung Bungie request stalls it past the budget,
            // the watchdog wins and we abandon this poll rather than parking the loop.
            const pollWork = (async () => {
                const players = getPlayersForSessionPolling(config.sessionPollingLimit);
                console.log(`[SESSIONS] Checking ${players.length} recently active players...`);
                const sessions = await pollActiveSessions(players, config.sessionPollingLimit, {
                    playerCheckConcurrency: config.activeSessionConcurrency,
                    staleCheckConcurrency: config.activeSessionStaleConcurrency,
                    staleReverifyLimit: config.activeSessionStaleReverifyLimit,
                });

                // Log summary by raid and record a snapshot for the session history endpoint.
                const raidBreakdown: Record<string, { fireteams: number; players: number }> = {};
                const raidNames = new Map<string, string>();
                for (const session of sessions) {
                    const entry = raidBreakdown[session.raidKey] ?? { fireteams: 0, players: 0 };
                    entry.fireteams += 1;
                    entry.players += session.playerCount;
                    raidBreakdown[session.raidKey] = entry;
                    raidNames.set(session.raidKey, session.raidName);
                }
                for (const [raidKey, counts] of Object.entries(raidBreakdown)) {
                    console.log(`  🎮 ${raidNames.get(raidKey) ?? raidKey}: ${counts.fireteams} fireteams, ${counts.players} players`);
                }

                recordSessionSnapshot({
                    totalFireteams: sessions.length,
                    totalPlayers: sessions.reduce((sum, s) => sum + s.playerCount, 0),
                    raidBreakdown,
                });

                // Resolve fireteam members not yet in the players table so their cards show
                // Name#Code instead of a raw membership id (capped per cycle).
                await resolveUnknownPartyMembers(collectPartyMemberIds(sessions));
            })();

            // Promise.race attaches reactions to BOTH promises, so if the abandoned pollWork
            // later settles (or stays pending — the accepted Option A leak of one hung
            // request), there is no unhandledRejection.
            const watchdog = new Promise<never>((_, reject) => {
                watchdogTimer = setTimeout(
                    () => reject(new PollWatchdogError(activeSessionPollWatchdogMs)),
                    activeSessionPollWatchdogMs
                );
            });

            await Promise.race([pollWork, watchdog]);

            // Completed within budget — record liveness for the health verdict.
            writeSessionHeartbeat();
        } catch (error) {
            if (error instanceof PollWatchdogError) {
                incrementSessionWatchdogTrips();
                console.warn(
                    `⚠️ [SESSIONS] Poll exceeded ${(activeSessionPollWatchdogMs / 1000).toFixed(0)}s watchdog — ` +
                    `abandoning this cycle and rescheduling. A Bungie request likely hung past its fetch timeout; ` +
                    `the orphaned work is left to settle.`
                );
            } else if (isBungieSystemDisabledError(error)) {
                // Record-only: the next iteration's top-of-try maintenance wait blocks until
                // it clears. Keeps a single maintenance-wait path and out of the error branch.
                recordBungieMaintenancePause('active session poll');
            } else {
                console.error('❌ Active session poll error:', error);
            }
        } finally {
            if (watchdogTimer) clearTimeout(watchdogTimer);
            if (!shouldStop && config.enableActiveSessionPolling) {
                const elapsed = Date.now() - startTime;
                const waitTime = Math.max(0, config.activeSessionIntervalMs - elapsed);
                console.log(`[SESSIONS] Poll took ${(elapsed / 1000).toFixed(1)}s, waiting ${(waitTime / 1000).toFixed(1)}s`);
                setTimeout(activeSessionLoop, waitTime);
            }
        }
    }

    // Cleanup loop. Deletes expired PGCRs in small per-batch transactions with a yield
    // between batches: one whole-backlog DELETE would hold the write lock for minutes
    // (starving the scanner into SQLITE_BUSY) and block this process's event loop,
    // freezing the crawl/session loops and timing out their in-flight requests.
    async function cleanupLoop() {
        if (shouldStop) return;

        console.log(`\n🧹 Running cleanup...`);

        try {
            const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
            const cutoffEpoch = Math.floor(Date.now() / 1000) - config.cleanupMaxAgeHours * 3600;

            let pgcrsDeleted = 0;
            let playersDeleted = 0;
            let batches = 0;

            while (!shouldStop) {
                const batch = deleteExpiredPGCRBatch(cutoffEpoch, config.cleanupBatchSize);
                pgcrsDeleted += batch.pgcrsDeleted;
                playersDeleted += batch.playersDeleted;
                if (batch.pgcrsDeleted > 0) batches++;

                if (batches > 0 && batches % 25 === 0 && batch.pgcrsDeleted > 0) {
                    console.log(
                        `🧹 Cleanup progress: ${pgcrsDeleted} PGCRs / ${playersDeleted} player entries removed (${batches} batches)...`
                    );
                }

                if (batch.done) break;
                await sleep(config.cleanupYieldMs);
            }

            console.log(
                `🧹 Cleanup: removed ${pgcrsDeleted} old PGCRs and ${playersDeleted} player entries` +
                (batches > 1 ? ` in ${batches} batches` : '')
            );

            const stats = getDbStatsLite();
            console.log('📊 Database stats:', stats);
        } catch (error) {
            console.error('❌ Cleanup error:', error);
        }

        setTimeout(cleanupLoop, config.cleanupIntervalMs);
    }

    // Start all loops
    crawlLoop();

    if (config.enableActiveSessionPolling) {
        // Delay active session polling to stagger API usage; override for local harnesses.
        setTimeout(activeSessionLoop, Math.max(0, activeSessionInitialDelayMs));
    }

    // Delay cleanup by 5 minutes
    setTimeout(cleanupLoop, 300000);
}

/**
 * Stop the crawler gracefully
 */
export function stopCrawler(): void {
    console.log('🛑 Stopping crawler...');
    shouldStop = true;
    writeCrawlerStatus('stopped');
}

/**
 * Check if the crawler is currently running
 */
export function isCrawlerRunning(): boolean {
    return isRunning;
}
