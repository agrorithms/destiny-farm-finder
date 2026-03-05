import 'dotenv/config';
import { runConcurrentDiscovery } from '../src/lib/discovery/snowball-concurrent';
import { getDbStats } from '../src/lib/db/queries';
import { closeDb } from '../src/lib/db';
import { getAllRaidDefinitions } from '../src/lib/bungie/manifest';

// ============================================
// CONFIGURATION — Edit these values!
// ============================================

// Add your seed players here
// You can find membership IDs on bungie.net or raid.report
// membershipType: 1 = Xbox, 2 = PSN, 3 = Steam
const SEED_PLAYERS = [
    // Example — replace with real players:
    { membershipId: '4611686018469615924', membershipType: 1 },
    { membershipId: '4611686018475332605', membershipType: 3 }, //frosty#1270
    { membershipId: '4611686018430910666', membershipType: 2 }, //wombat#5871
    { membershipId: '4611686018533113181', membershipType: 3 },
    { membershipId: '4611686018437585442', membershipType: 1 },
    { membershipId: '4611686018431717403', membershipType: 1 },
    { membershipId: '4611686018452637862', membershipType: 2 }, //3mr
    { membershipId: '4611686018441319193', membershipType: 1 },
    { membershipId: '4611686018501949714', membershipType: 2 },
    { membershipId: '4611686018530726821', membershipType: 1 },
    { membershipId: '4611686018506277701', membershipType: 3 },
    { membershipId: '4611686018521358615', membershipType: 1 }, //Wisp#4653
    { membershipId: '4611686018444299777', membershipType: 2 }, //Rhyme#8032
    { membershipId: '4611686018436929273', membershipType: 2 }, //Macca#3177
    { membershipId: '4611686018460347295', membershipType: 2 }, //Accessner#3340
    { membershipId: '4611686018513949048', membershipType: 3 }, //Aegis#2771
    { membershipId: '4611686018513261063', membershipType: 1 } //Alesia#8610
];

// How far back to look for PGCRs during discovery
const DISCOVERY_HOURS_BACK = parseInt(process.env.DISCOVERY_HOURS_BACK || '48', 10);

// How deep to snowball (each depth = 1 hop through PGCRs)
const MAX_DEPTH = parseInt(process.env.DISCOVERY_MAX_DEPTH || '2', 10);

// Max players to discover before stopping
const MAX_PLAYERS = parseInt(process.env.DISCOVERY_MAX_PLAYERS || '2000', 10);

// Number of concurrent workers
const CONCURRENCY = parseInt(process.env.DISCOVERY_CONCURRENCY || '5', 10);

// Optional: filter to a specific raid key
const RAID_FILTER: string | undefined = undefined;

// ============================================
// SCRIPT
// ============================================

async function main() {
    console.log('========================================');
    console.log('  Destiny Farm Finder — Player Discovery');
    console.log('  (Concurrent Mode)');
    console.log('========================================\n');

    if (SEED_PLAYERS.length === 0) {
        console.error('[ERROR] No seed players configured!');
        console.error('Edit scripts/discover.ts and add at least one seed player.\n');
        process.exit(1);
    }

    const raids = getAllRaidDefinitions();
    console.log('Available raids:');
    for (const [key, raid] of Object.entries(raids)) {
        console.log(`  ${key} — ${raid.name}`);
    }
    console.log('');

    const preStats = getDbStats();
    console.log('Database before discovery:', preStats);
    console.log('');

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[INFO] Received SIGINT. Results may be partial.');
        closeDb();
        process.exit(0);
    });

    try {
        const result = await runConcurrentDiscovery(SEED_PLAYERS, {
            maxDepth: MAX_DEPTH,
            maxPlayers: MAX_PLAYERS,
            hoursBack: DISCOVERY_HOURS_BACK,
            raidFilter: RAID_FILTER,
            concurrency: CONCURRENCY,
        });

        console.log('\n========================================');
        console.log('  Discovery Results');
        console.log('========================================');
        console.log(`  Players discovered: ${result.totalPlayersDiscovered}`);
        console.log(`  PGCRs processed:   ${result.totalPGCRsProcessed}`);
        console.log(`  New PGCRs stored:  ${result.totalNewPGCRs}`);
        console.log(`  Duration:          ${(result.duration / 1000).toFixed(1)}s`);

        if (Object.keys(result.playersByRaid).length > 0) {
            console.log('\n  Completions by raid:');
            for (const [raid, count] of Object.entries(result.playersByRaid)) {
                const raidName = raids[raid]?.name || raid;
                console.log(`    ${raidName}: ${count}`);
            }
        }

        if (result.topPlayers.length > 0) {
            console.log('\n  Top players by completions:');
            result.topPlayers.slice(0, 15).forEach((p, i) => {
                console.log(`    ${String(i + 1).padStart(2)}. ${p.displayName} — ${p.completions} completions`);
            });
        }

        const postStats = getDbStats();
        console.log('\n  Database after discovery:', postStats);
    } catch (error) {
        console.error('[ERROR] Discovery failed:', error);
    } finally {
        closeDb();
    }
}

main();
