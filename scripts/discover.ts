import 'dotenv/config';
import { runConcurrentDiscovery } from '../src/lib/discovery/snowball-concurrent';
import { getDbStats } from '../src/lib/db/queries';
import { getDb, closeDb } from '../src/lib/db';
import { getAllRaidDefinitions } from '../src/lib/bungie/manifest';
import { BungieClient, BungieAPIError } from '../src/lib/bungie/client';
import { isRaidActivityHash, getRaidKeyFromHash } from '../src/lib/bungie/manifest';
import { hasPGCR, insertFullPGCR } from '../src/lib/db/queries';
import { isoToUnix } from '../src/lib/utils/helpers';

// ============================================
// CONFIGURATION — Edit these values!
// ============================================

// Add your seed players here
// You can find membership IDs on bungie.net or raid.report
// membershipType: 1 = Xbox, 2 = PSN, 3 = Steam
const SEED_PLAYERS = [
    { membershipId: '4611686018469615924', membershipType: 1 },
    { membershipId: '4611686018461098605', membershipType: 2 }, //Soldier
    { membershipId: '4611686018554196330', membershipType: 3 }, //Dova
    { membershipId: '4611686018525503627', membershipType: 3 }, //Raven
    { membershipId: '4611686018471725925', membershipType: 2 }, //Lumis
    { membershipId: '4611686018530726821', membershipType: 1 }, //L
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


// Backward scan config
const BACKWARD_SCAN_ENABLED = process.env.DISCOVERY_BACKWARD_SCAN !== 'false';
const BACKWARD_SCAN_MAX = parseInt(process.env.DISCOVERY_BACKWARD_SCAN_MAX || '5000', 10);
const BACKWARD_SCAN_MAX_MISSES = parseInt(process.env.DISCOVERY_BACKWARD_SCAN_MAX_MISSES || '100', 10);

const VALID_MEMBERSHIP_TYPES = new Set([1, 2, 3, 5, 6]);

// ============================================
// DISCOVERY CLIENT (separate API key)
// ============================================

function getDiscoveryClient(): BungieClient {
    const apiKey = process.env.BUNGIE_DISCOVERY_API_KEY || process.env.BUNGIE_API_KEY;
    if (!apiKey) {
        throw new Error('No API key available. Set BUNGIE_DISCOVERY_API_KEY or BUNGIE_API_KEY.');
    }
    const rps = parseInt(process.env.DISCOVERY_REQUESTS_PER_SECOND || '25', 10);
    console.log(`  🔑 API key: ${process.env.BUNGIE_DISCOVERY_API_KEY ? 'dedicated discovery key' : 'shared main key'}`);
    console.log(`  ⚡ Rate limit: ${rps} req/s\n`);
    return new BungieClient(apiKey, rps);
}

// ============================================
// SCANNER POSITION HELPERS
// ============================================

function getScannerPosition(): bigint {
    const db = getDb();
    const row = db.prepare(
        "SELECT value FROM crawler_state WHERE key = 'scanner_position'"
    ).get() as { value: string } | undefined;
    return row ? BigInt(row.value) : BigInt(0);
}

function getHighestPGCRId(): bigint {
    const db = getDb();
    const row = db.prepare(
        'SELECT MAX(CAST(instance_id AS INTEGER)) as max_id FROM pgcrs'
    ).get() as { max_id: number | null } | undefined;
    return row?.max_id ? BigInt(row.max_id) : BigInt(0);
}

function updateScannerPosition(newPosition: bigint): void {
    const db = getDb();
    db.prepare(`
    INSERT INTO crawler_state (key, value, updated_at)
    VALUES ('scanner_position', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = unixepoch()
  `).run(newPosition.toString());
}

// ============================================
// FIND THE PRESENT
// ============================================

async function findPresentInstanceId(client: BungieClient): Promise<bigint> {
    const scannerPos = getScannerPosition();
    const highestPGCR = getHighestPGCRId();
    let startId = scannerPos > highestPGCR ? scannerPos : highestPGCR;

    console.log(`  🔍 Probing for present... starting from ${startId}`);

    // Phase 1: Exponential jumps to overshoot
    let lastValidId = startId;
    let currentId = startId;
    let jumpSize = BigInt(1000);
    let probeCount = 0;
    const maxProbes = 40;
    let overshotAt = BigInt(0);

    while (probeCount < maxProbes) {
        const probeId = currentId + jumpSize;
        probeCount++;

        const exists = await probeExists(client, probeId);
        console.log(`    ${exists ? '✅' : '❌'} Probe #${probeCount}: ${probeId} (jump +${jumpSize})`);

        if (exists) {
            lastValidId = probeId;
            currentId = probeId;
            jumpSize = jumpSize * BigInt(2);
        } else {
            overshotAt = probeId;
            break;
        }
    }

    if (overshotAt === BigInt(0)) {
        // Never overshot — just use the last valid ID
        console.log(`  📍 Using last valid probe: ${lastValidId}`);
        return lastValidId;
    }

    // Phase 2: Binary search between lastValidId and overshotAt
    let low = lastValidId;
    let high = overshotAt;
    let binaryCount = 0;

    console.log(`    🔎 Binary search: ${low} to ${high} (range: ${high - low})`);

    while (high - low > BigInt(500) && binaryCount < 25) {
        const mid = low + (high - low) / BigInt(2);
        binaryCount++;

        const exists = await probeExists(client, mid);

        if (exists) {
            low = mid;
        } else {
            high = mid;
        }
    }

    console.log(`  📍 Found approximate present: ${low} (${probeCount + binaryCount} total API calls)`);
    console.log(`  📏 Gap from scanner: ${low - startId} instance IDs`);
    return low;
}

/**
 * Check if a PGCR instance ID exists. Returns true/false, never throws.
 */
async function probeExists(client: BungieClient, instanceId: bigint): Promise<boolean> {
    try {
        const response = await client.getPGCR(instanceId.toString());
        return !!(response.Response && response.Response.activityDetails);
    } catch (error) {
        if (error instanceof BungieAPIError) {
            if (error.errorStatus === 'SystemDisabled') {
                throw error; // Let this bubble up — API is down
            }
        }
        return false;
    }
}


// ============================================
// BACKWARD SCAN
// ============================================

async function runBackwardScan(client: BungieClient): Promise<{
    scanned: number;
    raidsFound: number;
    playersDiscovered: number;
}> {
    const db = getDb();

    // Step 1: Find the present
    const presentId = await findPresentInstanceId(client);
    const scannerPosition = getScannerPosition();
    const gap = presentId - scannerPosition;

    // Step 2: IMMEDIATELY update scanner position so the forward scanner can jump ahead
    if (presentId > scannerPosition) {
        updateScannerPosition(presentId);
        console.log(`\n  🚀 Updated scanner position: ${scannerPosition} → ${presentId}`);
        console.log(`  📡 Forward scanner will continue from ${presentId} on next cycle`);
        console.log(`  🔄 Backward scan will now fill the gap of ${gap} instance IDs\n`);
    } else {
        console.log(`\n  ✅ Scanner is already at the present. No gap to fill.`);
        return { scanned: 0, raidsFound: 0, playersDiscovered: 0 };
    }

    // Step 3: Scan backward from present toward old scanner position
    console.log('  🔄 Scanning backward (newest → oldest)...');
    console.log(`  📍 From: ${presentId}`);
    console.log(`  📍 To:   ${scannerPosition}`);
    console.log(`  🔢 Max:  ${BACKWARD_SCAN_MAX}`);
    console.log('');

    let currentId = presentId;
    let scanned = 0;
    let raidsFound = 0;
    let playersDiscovered = 0;
    let consecutiveMisses = 0;

    const upsertPlayer = db.prepare(`
    INSERT INTO players (membership_id, membership_type, display_name, bungie_global_display_name, bungie_global_display_name_code, discovered_at, is_active)
    VALUES (?, ?, ?, ?, ?, unixepoch(), 1)
    ON CONFLICT(membership_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, players.display_name),
      bungie_global_display_name = COALESCE(excluded.bungie_global_display_name, players.bungie_global_display_name),
      bungie_global_display_name_code = COALESCE(excluded.bungie_global_display_name_code, players.bungie_global_display_name_code)
  `);

    while (scanned < BACKWARD_SCAN_MAX && consecutiveMisses < BACKWARD_SCAN_MAX_MISSES) {
        // Stop if we've reached the old scanner position
        if (currentId <= scannerPosition) {
            console.log('  🎉 Gap fully closed!');
            break;
        }

        currentId = currentId - BigInt(1);
        const instanceId = currentId.toString();
        scanned++;

        // Skip if we already have it
        if (hasPGCR(instanceId)) {
            consecutiveMisses = 0;
            continue;
        }

        try {
            const response = await client.getPGCR(instanceId);
            const pgcrData = response.Response;

            if (!pgcrData || !pgcrData.activityDetails) {
                consecutiveMisses++;
                continue;
            }

            consecutiveMisses = 0;

            const activityHash = pgcrData.activityDetails.directorActivityHash
                || pgcrData.activityDetails.referenceId;

            if (!isRaidActivityHash(activityHash)) {
                continue;
            }

            // 🎯 Found a raid!
            raidsFound++;
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

            const insertPlayers = db.transaction((entries: any[]) => {
                let added = 0;
                for (const entry of entries) {
                    if (!VALID_MEMBERSHIP_TYPES.has(Number(entry.membershipType))) continue;
                    upsertPlayer.run(
                        entry.membershipId,
                        entry.membershipType,
                        entry.displayName,
                        entry.bungieGlobalDisplayName || null,
                        null
                    );
                    added++;
                }
                return added;
            });

            playersDiscovered += insertPlayers(playerEntries);

            if (raidsFound % 10 === 0) {
                const covered = Number(presentId - currentId);
                const totalGap = Number(gap);
                const progress = totalGap > 0 ? ((covered / totalGap) * 100).toFixed(1) : '100';
                console.log(
                    `  🔍 Scanned ${scanned} | Raids ${raidsFound} | ` +
                    `Players ${playersDiscovered} | Gap: ${progress}% covered`
                );
            }
        } catch (error) {
            if (error instanceof BungieAPIError) {
                if (
                    error.errorCode === 1653 ||
                    error.errorStatus === 'DestinyPGCRNotFound' ||
                    error.errorCode === 7
                ) {
                    consecutiveMisses++;
                    continue;
                }
                if (error.errorStatus === 'SystemDisabled') {
                    console.error('  ⛔ Bungie API is disabled. Stopping backward scan.');
                    break;
                }
            }
            consecutiveMisses++;
        }
    }

    const covered = Number(presentId - currentId);
    const totalGap = Number(gap);
    const percentCovered = totalGap > 0 ? ((covered / totalGap) * 100).toFixed(1) : '100';

    const reason = currentId <= scannerPosition
        ? 'gap fully closed 🎉'
        : consecutiveMisses >= BACKWARD_SCAN_MAX_MISSES
            ? `consecutive misses (${consecutiveMisses})`
            : `scan limit reached (${BACKWARD_SCAN_MAX})`;

    console.log(`\n  ✅ Backward scan complete (${reason})`);
    console.log(`  📊 Scanned: ${scanned} | Raids: ${raidsFound} | Players: ${playersDiscovered}`);
    console.log(`  📏 Gap covered: ${percentCovered}% (${covered} of ${totalGap} IDs)`);

    return { scanned, raidsFound, playersDiscovered };
}

// ============================================
// MAIN
// ============================================

async function main() {
    console.log('========================================');
    console.log('  🎯 Destiny Farm Finder — Discovery');
    console.log('  (Concurrent + Backward Scan)');
    console.log('========================================\n');

    const client = getDiscoveryClient();

    if (SEED_PLAYERS.length === 0) {
        console.error('❌ No seed players configured!');
        process.exit(1);
    }

    const raids = getAllRaidDefinitions();
    console.log('🏰 Available raids:');
    for (const [key, raid] of Object.entries(raids)) {
        console.log(`  ${key} — ${raid.name}`);
    }
    console.log('');

    const preStats = getDbStats();
    console.log('📊 Database before discovery:', preStats);
    console.log('');

    process.on('SIGINT', () => {
        console.log('\n⚠️ Received SIGINT. Results may be partial.');
        closeDb();
        process.exit(0);
    });

    try {
        // ========== Phase 1: Snowball Discovery ==========
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  Phase 1: Snowball Discovery');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const discoveryResult = await runConcurrentDiscovery(SEED_PLAYERS, {
            maxDepth: MAX_DEPTH,
            maxPlayers: MAX_PLAYERS,
            hoursBack: DISCOVERY_HOURS_BACK,
            raidFilter: RAID_FILTER,
            concurrency: CONCURRENCY,
        });

        // ========== Phase 2: Backward Scan ==========
        let backwardResult = { scanned: 0, raidsFound: 0, playersDiscovered: 0 };

        if (BACKWARD_SCAN_ENABLED) {
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('  Phase 2: Backward Scan (Catch-Up)');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            backwardResult = await runBackwardScan(client);
        }

        // ========== Final Summary ==========
        console.log('\n========================================');
        console.log('  📋 Discovery Results');
        console.log('========================================');

        console.log('\n  Phase 1 — Snowball:');
        console.log(`    Players discovered: ${discoveryResult.totalPlayersDiscovered}`);
        console.log(`    PGCRs processed:   ${discoveryResult.totalPGCRsProcessed}`);
        console.log(`    New PGCRs stored:  ${discoveryResult.totalNewPGCRs}`);
        console.log(`    Duration:          ${(discoveryResult.duration / 1000).toFixed(1)}s`);

        if (BACKWARD_SCAN_ENABLED) {
            console.log('\n  Phase 2 — Backward Scan:');
            console.log(`    PGCRs scanned:     ${backwardResult.scanned}`);
            console.log(`    Raids found:       ${backwardResult.raidsFound}`);
            console.log(`    Players discovered: ${backwardResult.playersDiscovered}`);
        }

        if (Object.keys(discoveryResult.playersByRaid).length > 0) {
            console.log('\n  🏰 Completions by raid (Phase 1):');
            for (const [raid, count] of Object.entries(discoveryResult.playersByRaid)) {
                const raidName = raids[raid]?.name || raid;
                console.log(`    ${raidName}: ${count}`);
            }
        }

        if (discoveryResult.topPlayers.length > 0) {
            console.log('\n  🏆 Top players by completions:');
            discoveryResult.topPlayers.slice(0, 15).forEach((p, i) => {
                console.log(`    ${String(i + 1).padStart(2)}. ${p.displayName} — ${p.completions} completions`);
            });
        }

        const postStats = getDbStats();
        console.log('\n  📊 Database after discovery:', postStats);
    } catch (error) {
        console.error('❌ Discovery failed:', error);
    } finally {
        closeDb();
    }
}

main();
