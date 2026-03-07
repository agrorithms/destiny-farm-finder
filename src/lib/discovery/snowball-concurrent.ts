import { getBungieClient, BungieAPIError } from '../bungie/client';
import { isRaidActivityHash, getRaidKeyFromHash, getRaidNameFromHash } from '../bungie/manifest';
import { hasPGCR, getPlayerCount } from '../db/queries';
import { getDb } from '../db';
import { getCharacterIds, getRecentRaidActivities } from '../crawler/players';
import { fetchAndStorePGCR } from '../crawler/pgcr';
import { processWithConcurrency } from '../utils/concurrent';
import type { PlayerInfo } from '../bungie/types';

const VALID_MEMBERSHIP_TYPES = new Set([1, 2, 3, 5, 6]);

function isValidMembershipType(type: any): boolean {
    return VALID_MEMBERSHIP_TYPES.has(Number(type));
}


// =====================
// TYPES
// =====================

export interface DiscoveryConfig {
    maxDepth: number;
    maxPlayers: number;
    hoursBack: number;
    raidFilter?: string;
    concurrency: number;
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

interface PlayerProcessResult {
    newPGCRs: number;
    discoveredPlayers: PlayerInfo[];
    completionsByRaid: Map<string, number>;
    playerCompletions: Map<string, number>;
}

// =====================
// PLAYER PROCESSING
// =====================

/**
 * Process a single player: fetch their characters, get recent raid activities,
 * and fetch any new PGCRs. Returns discovered players and PGCR data.
 */
async function processPlayer(
    player: { membershipId: string; membershipType: number },
    hoursBack: number,
    raidFilter: string | undefined,
    processedPGCRs: Set<string>
): Promise<PlayerProcessResult> {
    const discoveredPlayers: PlayerInfo[] = [];
    const completionsByRaid = new Map<string, number>();
    const playerCompletions = new Map<string, number>();
    let newPGCRs = 0;

    // Get character IDs
    const characterIds = await getCharacterIds(player.membershipType, player.membershipId);
    if (characterIds.length === 0) {
        return { newPGCRs, discoveredPlayers, completionsByRaid, playerCompletions };
    }

    // Collect all activity instance IDs across characters
    const activityInstanceIds: Array<{ instanceId: string; activityHash: number }> = [];

    for (const characterId of characterIds) {
        const activities = await getRecentRaidActivities(
            player.membershipType,
            player.membershipId,
            characterId,
            hoursBack,
            50
        );

        for (const activity of activities) {
            // Check raid filter
            if (raidFilter) {
                const raidKey = getRaidKeyFromHash(activity.activityHash);
                if (raidKey !== raidFilter) continue;
            }

            // Skip already-processed PGCRs
            if (processedPGCRs.has(activity.instanceId)) continue;
            processedPGCRs.add(activity.instanceId);

            activityInstanceIds.push({
                instanceId: activity.instanceId,
                activityHash: activity.activityHash,
            });
        }
    }

    // Fetch each new PGCR
    for (const activity of activityInstanceIds) {
        const processed = await fetchAndStorePGCR(activity.instanceId);

        if (processed) {
            newPGCRs++;

            if (processed.raidKey && processed.completed) {
                const count = completionsByRaid.get(processed.raidKey) || 0;
                completionsByRaid.set(processed.raidKey, count + 1);
            }

            for (const discoveredPlayer of processed.players) {
                discoveredPlayers.push(discoveredPlayer);

                if (processed.completed) {
                    const existing = playerCompletions.get(discoveredPlayer.membershipId) || 0;
                    playerCompletions.set(discoveredPlayer.membershipId, existing + 1);
                }
            }
        }
    }

    return { newPGCRs, discoveredPlayers, completionsByRaid, playerCompletions };
}

// =====================
// BULK PLAYER UPSERT
// =====================

/**
 * Bulk upsert players into the database.
 * Uses a transaction for efficiency.
 */
function bulkUpsertDiscoveredPlayers(
    players: Array<{
        membershipId: string;
        membershipType: number;
        displayName: string;
        bungieGlobalDisplayName?: string;
        bungieGlobalDisplayNameCode?: number;
    }>
): void {
    if (players.length === 0) return;

    const db = getDb();
    const upsert = db.prepare(`
    INSERT INTO players (membership_id, membership_type, display_name, bungie_global_display_name, bungie_global_display_name_code, discovered_at, is_active)
    VALUES (?, ?, ?, ?, ?, unixepoch(), 1)
    ON CONFLICT(membership_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, players.display_name),
      bungie_global_display_name = COALESCE(excluded.bungie_global_display_name, players.bungie_global_display_name),
      bungie_global_display_name_code = COALESCE(excluded.bungie_global_display_name_code, players.bungie_global_display_name_code)
  `);

    const insertMany = db.transaction((entries: typeof players) => {
        for (const p of entries) {
            if (!isValidMembershipType(p.membershipType)) continue;
            upsert.run(
                p.membershipId,
                p.membershipType,
                p.displayName,
                p.bungieGlobalDisplayName || null,
                p.bungieGlobalDisplayNameCode || null
            );
        }
    });

    insertMany(players);

}

// =====================
// MAIN DISCOVERY FUNCTION
// =====================

/**
 * Run the snowball discovery with concurrent player processing.
 */
export async function runConcurrentDiscovery(
    seedPlayers: Array<{ membershipId: string; membershipType: number }>,
    config?: Partial<DiscoveryConfig>
): Promise<DiscoveryResult> {
    const {
        maxDepth = parseInt(process.env.DISCOVERY_MAX_DEPTH || '2', 10),
        maxPlayers = parseInt(process.env.DISCOVERY_MAX_PLAYERS || '2000', 10),
        hoursBack = parseInt(process.env.DISCOVERY_HOURS_BACK || '48', 10),
        raidFilter,
        concurrency = parseInt(process.env.DISCOVERY_CONCURRENCY || '5', 10),
    } = config || {};

    const startTime = Date.now();

    // Track all discovered players and their completion counts
    const allPlayers = new Map<string, PlayerInfo & { completions: number }>();
    const processedPGCRs = new Set<string>();
    const processedPlayerIds = new Set<string>();
    let totalNewPGCRs = 0;

    const completionsByRaid = new Map<string, number>();

    let currentWave: Array<{ membershipId: string; membershipType: number }> = [...seedPlayers];

    console.log('\n[DISCOVERY] Starting concurrent snowball discovery');
    console.log(`  Seeds:       ${seedPlayers.length} players`);
    console.log(`  Max depth:   ${maxDepth}`);
    console.log(`  Max players: ${maxPlayers}`);
    console.log(`  Hours back:  ${hoursBack}`);
    console.log(`  Concurrency: ${concurrency} workers`);
    if (raidFilter) console.log(`  Raid filter: ${raidFilter}`);
    console.log('');

    for (let depth = 0; depth < maxDepth; depth++) {
        if (currentWave.length === 0) {
            console.log(`  [DEPTH ${depth}] No more players to process. Stopping.`);
            break;
        }

        if (allPlayers.size >= maxPlayers) {
            console.log(`  [DISCOVERY] Reached max player limit (${maxPlayers}). Stopping.`);
            break;
        }

        // Filter out already-processed players
        const playersToProcess = currentWave.filter(
            (p) => !processedPlayerIds.has(p.membershipId)
        );

        // Cap the wave if we're approaching the player limit
        const remainingCapacity = maxPlayers - allPlayers.size;
        const cappedWave = playersToProcess.slice(0, Math.max(remainingCapacity, playersToProcess.length));

        console.log(
            `  [DEPTH ${depth}] Processing ${cappedWave.length} players with ${concurrency} concurrent workers...`
        );

        const depthStartTime = Date.now();
        let depthNewPGCRs = 0;
        let depthNewPlayers = 0;
        const nextWave: Array<{ membershipId: string; membershipType: number }> = [];

        // Process players concurrently
        let depthNewPGCRsCounter = 0;
        let depthNewPlayersCounter = 0;

        const results = await processWithConcurrency(
            cappedWave,
            concurrency,
            async (player) => {
                processedPlayerIds.add(player.membershipId);
                const result = await processPlayer(player, hoursBack, raidFilter, processedPGCRs);
                // Update counters as each player completes
                depthNewPGCRsCounter += result.newPGCRs;
                depthNewPlayersCounter += result.discoveredPlayers.length;
                return result;
            },
            (completed, total) => {
                if (completed % 25 === 0 || completed === total) {
                    const elapsed = ((Date.now() - depthStartTime) / 1000).toFixed(0);
                    console.log(
                        `  [DEPTH ${depth}] Progress: ${completed}/${total} players, ` +
                        `${depthNewPGCRsCounter} new PGCRs, ${depthNewPlayersCounter} new players, ${elapsed}s elapsed`
                    );
                }
            }
        );

        // Merge results from all workers
        for (const result of results) {
            if (!result.success) continue;

            const {
                newPGCRs,
                discoveredPlayers,
                completionsByRaid: playerRaidCompletions,
                playerCompletions,
            } = result.result;

            depthNewPGCRs += newPGCRs;
            totalNewPGCRs += newPGCRs;

            // Merge raid completion counts
            for (const [raid, count] of playerRaidCompletions) {
                const existing = completionsByRaid.get(raid) || 0;
                completionsByRaid.set(raid, existing + count);
            }

            // Merge discovered players
            for (const player of discoveredPlayers) {
                if (!allPlayers.has(player.membershipId)) {
                    allPlayers.set(player.membershipId, {
                        ...player,
                        completions: 0,
                    });
                    depthNewPlayers++;

                    nextWave.push({
                        membershipId: player.membershipId,
                        membershipType: player.membershipType,
                    });
                }

                // Update completion count
                const completionCount = playerCompletions.get(player.membershipId) || 0;
                if (completionCount > 0) {
                    const existing = allPlayers.get(player.membershipId)!;
                    existing.completions += completionCount;
                }
            }
        }

        // Store discovered players in the database after each depth
        const newPlayersForDb = [...allPlayers.values()]
            .filter((p) => nextWave.some((nw) => nw.membershipId === p.membershipId))
            .map((p) => ({
                membershipId: p.membershipId,
                membershipType: p.membershipType,
                displayName: p.displayName,
                bungieGlobalDisplayName: p.bungieGlobalDisplayName,
                bungieGlobalDisplayNameCode: p.bungieGlobalDisplayNameCode,
            }));

        if (newPlayersForDb.length > 0) {
            bulkUpsertDiscoveredPlayers(newPlayersForDb);
        }

        const depthElapsed = ((Date.now() - depthStartTime) / 1000).toFixed(1);
        console.log(
            `  [DEPTH ${depth}] Complete in ${depthElapsed}s: ${depthNewPGCRs} new PGCRs, ` +
            `${depthNewPlayers} new players (total: ${allPlayers.size} players, ${processedPGCRs.size} PGCRs)`
        );

        currentWave = nextWave;
    }

    // Final bulk upsert of all players
    const allPlayersList = [...allPlayers.values()].map((p) => ({
        membershipId: p.membershipId,
        membershipType: p.membershipType,
        displayName: p.displayName,
        bungieGlobalDisplayName: p.bungieGlobalDisplayName,
        bungieGlobalDisplayNameCode: p.bungieGlobalDisplayNameCode,
    }));

    if (allPlayersList.length > 0) {
        bulkUpsertDiscoveredPlayers(allPlayersList);
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

    console.log(`\n[DISCOVERY] Complete in ${(duration / 1000).toFixed(1)}s`);
    console.log(`  Total players discovered: ${allPlayers.size}`);
    console.log(`  Total PGCRs processed: ${processedPGCRs.size}`);
    console.log(`  New PGCRs stored: ${totalNewPGCRs}`);
    console.log(`  Players in DB: ${getPlayerCount()}`);

    if (topPlayers.length > 0) {
        console.log(`\n[LEADERBOARD] Top players by completions:`);
        topPlayers.slice(0, 10).forEach((p, i) => {
            console.log(`  ${String(i + 1).padStart(2)}. ${p.displayName} — ${p.completions} completions`);
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
