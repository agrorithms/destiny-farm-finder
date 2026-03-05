import { NextResponse } from 'next/server';
import { getDbStats, getCrawlerStatus } from '@/lib/db/queries';

export async function GET() {
    try {
        const stats = getDbStats();
        const crawlerStatus = getCrawlerStatus();

        return NextResponse.json({
            crawlerRunning: crawlerStatus.isRunning,
            crawlerStatus: crawlerStatus.status,
            lastHeartbeat: crawlerStatus.lastHeartbeat,
            secondsSinceHeartbeat: crawlerStatus.secondsSinceHeartbeat,
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
