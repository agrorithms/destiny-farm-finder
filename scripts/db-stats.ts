import 'dotenv/config';
import { getDbStats, getLeaderboard } from '../src/lib/db/queries';
import { getAllRaidDefinitions } from '../src/lib/bungie/manifest';
import { closeDb } from '../src/lib/db';

async function main() {
    console.log('========================================');
    console.log('  Destiny Farm Finder — Database Stats');
    console.log('========================================\n');

    const stats = getDbStats();
    console.log('Database overview:');
    console.log(`  Total players:      ${stats.totalPlayers}`);
    console.log(`  Total PGCRs:        ${stats.totalPGCRs}`);
    console.log(`  Total PGCR entries: ${stats.totalPGCRPlayers}`);
    console.log(`  Active sessions:    ${stats.activeSessions}`);
    console.log(`  Oldest PGCR:        ${stats.oldestPGCR || 'N/A'}`);
    console.log(`  Newest PGCR:        ${stats.newestPGCR || 'N/A'}`);

    // Show leaderboards for each raid (last 4 hours)
    const raids = getAllRaidDefinitions();
    const hoursBack = 4;

    console.log(`\nLeaderboards (last ${hoursBack} hours, full clears only):`);
    console.log('----------------------------------------');

    for (const [key, raid] of Object.entries(raids)) {
        const leaderboard = getLeaderboard({
            raidKey: key,
            hoursBack,
            limit: 10,
            fullClearsOnly: true,
        });

        if (leaderboard.length === 0) continue;

        console.log(`\n  ${raid.name}:`);
        leaderboard.forEach((entry, i) => {
            const name = entry.bungieGlobalDisplayName || entry.displayName;
            console.log(`    ${String(i + 1).padStart(2)}. ${name} — ${entry.completions} clears`);
        });
    }

    // Show overall leaderboard
    const overall = getLeaderboard({
        hoursBack,
        limit: 15,
        fullClearsOnly: true,
    });

    if (overall.length > 0) {
        console.log(`\n  All Raids Combined:`);
        overall.forEach((entry, i) => {
            const name = entry.bungieGlobalDisplayName || entry.displayName;
            console.log(`    ${String(i + 1).padStart(2)}. ${name} — ${entry.completions} clears`);
        });
    }

    closeDb();
}

main();
