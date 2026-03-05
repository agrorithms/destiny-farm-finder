import { NextResponse } from 'next/server';
import { getDbStats, getCrawlerStatus } from '@/lib/db/queries';
import { getDb } from '@/lib/db';

export async function GET() {
    try {
        const stats = getDbStats();
        const crawlerStatus = getCrawlerStatus();

        // Read scanner stats from database (scanner runs in a separate process)
        const db = getDb();
        const scannerStatsRow = db.prepare(
            "SELECT value, updated_at FROM crawler_state WHERE key = 'scanner_stats'"
        ).get() as { value: string; updated_at: number } | undefined;

        let scannerStats = null;
        if (scannerStatsRow) {
            try {
                const parsed = JSON.parse(scannerStatsRow.value);
                const secondsSinceUpdate = Math.floor(Date.now() / 1000) - scannerStatsRow.updated_at;
                scannerStats = {
                    ...parsed,
                    isRunning: secondsSinceUpdate < 60, // Consider running if updated within last minute
                    secondsSinceUpdate,
                };
            } catch {
                scannerStats = null;
            }
        }

        return NextResponse.json({
            crawlerRunning: crawlerStatus.isRunning,
            crawlerStatus: crawlerStatus.status,
            lastHeartbeat: crawlerStatus.lastHeartbeat,
            secondsSinceHeartbeat: crawlerStatus.secondsSinceHeartbeat,
            scanner: scannerStats,
            database: stats,
        });
    } catch (error) {
        console.error('[ERROR] Stats query failed:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
