import 'dotenv/config';
import { startCrawler, stopCrawler } from '../src/lib/crawler';
import { getDbStats, getPlayerCount } from '../src/lib/db/queries';
import { closeDb } from '../src/lib/db';

// ============================================
// CONFIGURATION
// ============================================

const CRAWLER_CONFIG = {
    intervalMs: parseInt(process.env.CRAWLER_INTERVAL_MS || '90000', 10),
    maxPlayersPerCycle: parseInt(process.env.CRAWLER_MAX_PLAYERS_PER_CYCLE || '50', 10),
    hoursBack: 24,
    enableActiveSessionPolling: true,
    activeSessionIntervalMs: 300000, // 5 minutes
    cleanupIntervalMs: 1800000, // 30 minutes
    cleanupMaxAgeHours: 32,
};

// ============================================
// SCRIPT
// ============================================

async function main() {
    console.log('========================================');
    console.log('  Destiny Farm Finder — Crawler');
    console.log('========================================\n');

    // Check if we have players to crawl
    const playerCount = getPlayerCount();
    if (playerCount === 0) {
        console.error('[ERROR] No players in the database!');
        console.error('Run the discovery tool first to seed players:');
        console.error('  npx tsx scripts/discover.ts\n');
        process.exit(1);
    }

    const stats = getDbStats();
    console.log('Database stats:', stats);
    console.log('');
    console.log('Crawler config:', CRAWLER_CONFIG);
    console.log('');
    console.log('Starting crawler... Press Ctrl+C to stop.\n');

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[INFO] Received SIGINT. Shutting down gracefully...');
        stopCrawler();
        setTimeout(() => {
            closeDb();
            console.log('[INFO] Shutdown complete.');
            process.exit(0);
        }, 2000);
    });

    process.on('SIGTERM', () => {
        console.log('\n[INFO] Received SIGTERM. Shutting down gracefully...');
        stopCrawler();
        setTimeout(() => {
            closeDb();
            console.log('[INFO] Shutdown complete.');
            process.exit(0);
        }, 2000);
    });

    // Start the crawler
    await startCrawler(CRAWLER_CONFIG);
}

main();
