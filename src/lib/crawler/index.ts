import { getPlayersForSessionPolling, getPlayersToCrawl, getPlayerCount, bulkUpsertPlayers, cleanupOldPGCRs, getDbStats } from '../db/queries';
import { crawlPlayer } from './players';
import { pollActiveSessions } from './active-sessions';
import { getDb } from '../db';
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

export interface CrawlerConfig {
    intervalMs: number;
    maxPlayersPerCycle: number;
    hoursBack: number;
    enableActiveSessionPolling: boolean;
    activeSessionIntervalMs: number;
    cleanupIntervalMs: number;
    cleanupMaxAgeHours: number;
}

const DEFAULT_CONFIG: CrawlerConfig = {
    intervalMs: parseInt(process.env.CRAWLER_INTERVAL_MS || '90000', 10),
    maxPlayersPerCycle: parseInt(process.env.CRAWLER_MAX_PLAYERS_PER_CYCLE || '50', 10),
    hoursBack: parseInt(process.env.CRAWLER_HOURS_BACK || '24', 10),
    enableActiveSessionPolling: true,
    activeSessionIntervalMs: 120000, // 2 minutes
    cleanupIntervalMs: 1800000, // 30 minutes
    cleanupMaxAgeHours: parseInt(process.env.CRAWLER_CLEANUP_MAX_AGE_HOURS || '24', 10),
};

let isRunning = false;
let shouldStop = false;

/**
 * Run a single crawl cycle: pick players, crawl their activity history,
 * fetch new PGCRs, and discover new players.
 */
async function crawlCycle(config: CrawlerConfig): Promise<{
    playersCrawled: number;
    newPGCRs: number;
    newPlayersDiscovered: number;
}> {
    const players = getPlayersToCrawl(config.maxPlayersPerCycle);

    if (players.length === 0) {
        console.log('⚠️ No players to crawl. Run the discovery tool first to seed players.');
        return { playersCrawled: 0, newPGCRs: 0, newPlayersDiscovered: 0 };
    }

    let totalNewPGCRs = 0;
    const allDiscoveredPlayers: PlayerInfo[] = [];

    for (const player of players) {
        if (shouldStop) break;

        const result = await crawlPlayer(player, config.hoursBack);
        totalNewPGCRs += result.newPGCRs;
        allDiscoveredPlayers.push(...result.discoveredPlayers);
    }

    // Bulk insert newly discovered players
    if (allDiscoveredPlayers.length > 0) {
        bulkUpsertPlayers(allDiscoveredPlayers);
    }

    return {
        playersCrawled: players.length,
        newPGCRs: totalNewPGCRs,
        newPlayersDiscovered: allDiscoveredPlayers.length,
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
        hoursBack: config.hoursBack,
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
            console.error('❌ Crawl cycle error:', error);
        }

        const elapsed = Date.now() - startTime;
        const waitTime = Math.max(0, config.intervalMs - elapsed);

        console.log(`⏱️ Cycle took ${(elapsed / 1000).toFixed(1)}s, waiting ${(waitTime / 1000).toFixed(1)}s`);

        setTimeout(crawlLoop, waitTime);
    }

    // Active session polling loop (separate interval)
    async function activeSessionLoop() {
        if (shouldStop || !config.enableActiveSessionPolling) return;

        console.log(`\n👁️ Polling active sessions...`);

        try {
            const players = getPlayersForSessionPolling(200); // Check more players for sessions
            console.log(`[SESSIONS] Checking ${players.length} recently active players...`);
            const sessions = await pollActiveSessions(players, 200);

            // Log summary by raid
            const byRaid = new Map<string, number>();
            for (const session of sessions) {
                const count = byRaid.get(session.raidName) || 0;
                byRaid.set(session.raidName, count + 1);
            }
            for (const [raid, count] of byRaid) {
                console.log(`  🎮 ${raid}: ${count} active sessions`);
            }
        } catch (error) {
            console.error('❌ Active session poll error:', error);
        }

        setTimeout(activeSessionLoop, config.activeSessionIntervalMs);
    }

    // Cleanup loop
    async function cleanupLoop() {
        if (shouldStop) return;

        console.log(`\n🧹 Running cleanup...`);

        try {
            const result = cleanupOldPGCRs(config.cleanupMaxAgeHours);
            console.log(
                `🧹 Cleanup: removed ${result.pgcrsDeleted} old PGCRs and ${result.playersDeleted} player entries`
            );

            const stats = getDbStats();
            console.log('📊 Database stats:', stats);
        } catch (error) {
            console.error('❌ Cleanup error:', error);
        }

        setTimeout(cleanupLoop, config.cleanupIntervalMs);
    }

    // Start all loops
    crawlLoop();

    if (config.enableActiveSessionPolling) {
        // Delay active session polling by 30 seconds to stagger API usage
        setTimeout(activeSessionLoop, 30000);
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
