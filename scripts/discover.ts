import 'dotenv/config';
import { runDiscovery } from '../src/lib/discovery/snowball';
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
    { membershipId: '4611686018533113181', membershipType: 3 },
    { membershipId: '4611686018437585442', membershipType: 1 },
    { membershipId: '4611686018431717403', membershipType: 1 },
    { membershipId: '4611686018452637862', membershipType: 2 },
    { membershipId: '4611686018441319193', membershipType: 1 },
    { membershipId: '4611686018501949714', membershipType: 2 },
    { membershipId: '4611686018530726821', membershipType: 1 },
    { membershipId: '4611686018506277701', membershipType: 3 },
    { membershipId: '4611686018436929273', membershipType: 2 }
];

// How many hours back to look
const DISCOVERY_HOURS_BACK = 24;

// How deep to snowball (each depth = 1 hop through PGCRs)
const MAX_DEPTH = 2;

// Max players to discover before stopping
const MAX_PLAYERS = 2000;

// Optional: filter to a specific raid (use raid key from manifest.ts)
// Set to undefined to discover across all raids
// Examples: 'garden_of_salvation', 'last_wish', 'salvations_edge', etc.
const RAID_FILTER: string | undefined = undefined;

// ============================================
// SCRIPT
// ============================================

async function main() {
    console.log('========================================');
    console.log('  Destiny Farm Finder — Player Discovery');
    console.log('========================================\n');

    // Validate seed players
    if (SEED_PLAYERS.length === 0) {
        console.error('[ERROR] No seed players configured!');
        console.error('Edit scripts/discover.ts and add at least one seed player to SEED_PLAYERS.\n');
        console.error('You can find membership IDs at:');
        console.error('  - https://www.bungie.net (your profile URL)');
        console.error('  - https://raid.report (search for a player)\n');
        console.error('Example:');
        console.error('  { membershipId: "4611686018469615924", membershipType: 3 }');
        process.exit(1);
    }

    // Show available raids
    const raids = getAllRaidDefinitions();
    console.log('Available raids:');
    for (const [key, raid] of Object.entries(raids)) {
        console.log(`  ${key} — ${raid.name}`);
    }
    console.log('');

    // Show pre-discovery stats
    const preStats = getDbStats();
    console.log('Database before discovery:', preStats);
    console.log('');

    // Run discovery
    try {
        const result = await runDiscovery(SEED_PLAYERS, {
            maxDepth: MAX_DEPTH,
            maxPlayers: MAX_PLAYERS,
            hoursBack: DISCOVERY_HOURS_BACK,
            raidFilter: RAID_FILTER,
        });

        // Show post-discovery stats
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
