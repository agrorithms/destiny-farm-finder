import { getBungieClient } from '../bungie/client';
import { isRaidActivityHash, getRaidKeyFromHash, getRaidNameFromHash } from '../bungie/manifest';
import { hasPGCR, bulkUpsertPlayers, getPlayerCount } from '../db/queries';
import { fetchAndStorePGCR } from '../crawler/pgcr';
import { getCharacterIds, getRecentRaidActivities } from '../crawler/players';
import type { PlayerInfo } from '../bungie/types';

export interface DiscoveryConfig {
    maxDepth: number;
    maxPlayers: number;
    hoursBack: number;
    raidFilter?: string; // Optional: only discover for a specific raid key
}

export interface DiscoveryResult {
    totalPlayersDiscovered: number;
    totalPGCRsProcessed: number;
    totalNewPGCRs: number;
    playersByRaid: Record<string, number>;
    topPlayers: Array<{
        displayName: string;
        membershipId: string;
        completions: number;
    }>;
    duration: number;
}

/**
 * Run the snowball discovery process starting from one or more seed players.
 * 
 * How it works:
 * 1. Start with seed players
 * 2. Fetch their recent raid activity history
 * 3. Fetch each PGCR to discover new players
 * 4. Repeat for newly discovered players up to maxDepth
 * 5. Store everything in the database
 */
export async function runDiscovery(
    seedPlayers: Array<{ membershipId: string; membershipType: number }>,
    config?: Partial<DiscoveryConfig>
): Promise<DiscoveryResult> {
    const {
        maxDepth = parseInt(process.env.DISCOVERY_MAX_DEPTH || '2', 10),
        maxPlayers = parseInt(process.env.DISCOVERY_MAX_PLAYERS || '1000', 10),
        hoursBack = 4,
        raidFilter,
    } = config || {};

    const startTime = Date.now();

    // Track all discovered players and their completion counts
    const allPlayers = new Map<string, PlayerInfo & { completions: number }>();
    const processedPGCRs = new Set<string>();
    const processedPlayerIds = new Set<string>();
    let totalNewPGCRs = 0;

    // Track completions by raid
    const completionsByRaid = new Map<string, number>();

    // Initialize current wave with seed players
    let currentWave: Array<{ membershipId: string; membershipType: number }> = [...seedPlayers];

    console.log(`\n🔍 Starting snowball discovery`);
    console.log(`   Seeds: ${seedPlayers.length} players`);
    console.log(`   Max depth: ${maxDepth}`);
    console.log(`   Max players: ${maxPlayers}`);
    console.log(`   Hours back: ${hoursBack}`);
    if (raidFilter) console.log(`   Raid filter: ${raidFilter}`);
    console.log('');

    for (let depth = 0; depth < maxDepth; depth++) {
        if (currentWave.length === 0) {
            console.log(`   Depth ${depth}: No more players to process. Stopping.`);
            break;
        }

        if (allPlayers.size >= maxPlayers) {
            console.log(`   Reached max player limit (${maxPlayers}). Stopping.`);
            break;
        }

        const nextWave: Array<{ membershipId: string; membershipType: number }> = [];
        let depthNewPGCRs = 0;
        let depthNewPlayers = 0;

        console.log(`   📊 Depth ${depth}: Processing ${currentWave.length} players...`);

        for (const seed of currentWave) {
            if (allPlayers.size >= maxPlayers) break;
            if (processedPlayerIds.has(seed.membershipId)) continue;

            processedPlayerIds.add(seed.membershipId);

            // Get character IDs
            const characterIds = await getCharacterIds(seed.membershipType, seed.membershipId);
            if (characterIds.length === 0) continue;

            // Get recent raid activities across all characters
            for (const characterId of characterIds) {
                const activities = await getRecentRaidActivities(
                    seed.membershipType,
                    seed.membershipId,
                    characterId,
                    hoursBack,
                    50
                );

                for (const activity of activities) {
                    if (processedPGCRs.has(activity.instanceId)) continue;
                    processedPGCRs.add(activity.instanceId);

                    // Apply raid filter if specified
                    if (raidFilter) {
                        const raidKey = getRaidKeyFromHash(activity.activityHash);
                        if (raidKey !== raidFilter) continue;
                    }

                    // Fetch and store the PGCR
                    const processed = await fetchAndStorePGCR(activity.instanceId);

                    if (processed) {
                        depthNewPGCRs++;
                        totalNewPGCRs++;

                        // Track raid completions
                        if (processed.raidKey && processed.completed) {
                            const count = completionsByRaid.get(processed.raidKey) || 0;
                            completionsByRaid.set(processed.raidKey, count + 1);
                        }

                        // Discover players from this PGCR
                        for (const player of processed.players) {
                            if (!allPlayers.has(player.membershipId)) {
                                allPlayers.set(player.membershipId, {
                                    ...player,
                                    completions: 0,
                                });
                                depthNewPlayers++;

                                // Add to next wave for further discovery
                                nextWave.push({
                                    membershipId: player.membershipId,
                                    membershipType: player.membershipType,
                                });
                            }

                            // Count completions (if the PGCR was completed)
                            if (processed.completed) {
                                const existing = allPlayers.get(player.membershipId)!;
                                existing.completions++;
                            }
                        }
                    }
                }
            }
        }

        console.log(
            `   ✅ Depth ${depth}: ${depthNewPGCRs} new PGCRs, ${depthNewPlayers} new players ` +
            `(total: ${allPlayers.size} players, ${processedPGCRs.size} PGCRs)`
        );

        currentWave = nextWave;
    }

    // Store all discovered players in the database
    const playerList = [...allPlayers.values()].map((p) => ({
        membershipId: p.membershipId,
        membershipType: p.membershipType,
        displayName: p.displayName,
        bungieGlobalDisplayName: p.bungieGlobalDisplayName,
        bungieGlobalDisplayNameCode: p.bungieGlobalDisplayNameCode,
    }));

    if (playerList.length > 0) {
        bulkUpsertPlayers(playerList);
    }

    // Build results
    const topPlayers = [...allPlayers.values()]
        .sort((a, b) => b.completions - a.completions)
        .slice(0, 25)
        .map((p) => ({
            displayName: p.bungieGlobalDisplayName || p.displayName,
            membershipId: p.membershipId,
            completions: p.completions,
        }));

    const playersByRaid: Record<string, number> = {};
    for (const [raid, count] of completionsByRaid) {
        playersByRaid[raid] = count;
    }

    const duration = Date.now() - startTime;

    console.log(`\n🎉 Discovery complete in ${(duration / 1000).toFixed(1)}s`);
    console.log(`   Total players discovered: ${allPlayers.size}`);
    console.log(`   Total PGCRs processed: ${processedPGCRs.size}`);
    console.log(`   New PGCRs stored: ${totalNewPGCRs}`);
    console.log(`   Players in DB: ${getPlayerCount()}`);

    if (topPlayers.length > 0) {
        console.log(`\n🏆 Top players by completions:`);
        topPlayers.slice(0, 10).forEach((p, i) => {
            console.log(`   ${i + 1}. ${p.displayName} — ${p.completions} completions`);
        });
    }

    return {
        totalPlayersDiscovered: allPlayers.size,
        totalPGCRsProcessed: processedPGCRs.size,
        totalNewPGCRs,
        playersByRaid,
        topPlayers,
        duration,
    };
}
