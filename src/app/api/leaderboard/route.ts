import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAllRaidDefinitions, getRaidNameFromHash } from '@/lib/bungie/manifest';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;

    // Support comma-separated raid keys: ?raids=garden_of_salvation,salvations_edge,vow_of_the_disciple
    const raidsParam = searchParams.get('raids') || '';
    const hours = parseInt(searchParams.get('hours') || '4', 10);
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const fullClearsOnly = searchParams.get('fullClearsOnly') !== 'false';
    const mode = searchParams.get('mode') || 'aggregate'; // 'aggregate' or 'individual'

    const allRaids = getAllRaidDefinitions();

    // Parse raid keys
    const raidKeys = raidsParam
        ? raidsParam.split(',').filter((key) => allRaids[key])
        : [];

    if (hours < 1 || hours > 168) {
        return NextResponse.json(
            { error: 'hours must be between 1 and 168' },
            { status: 400 }
        );
    }

    if (limit < 1 || limit > 500) {
        return NextResponse.json(
            { error: 'limit must be between 1 and 500' },
            { status: 400 }
        );
    }

    try {
        const db = getDb();
        const cutoff = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

        if (mode === 'individual' && raidKeys.length > 0) {
            // Return separate leaderboards for each selected raid
            const leaderboards: Record<string, any> = {};

            for (const raidKey of raidKeys) {
                let query = `
          SELECT
            pp.membership_id as membershipId,
            pp.membership_type as membershipType,
            COALESCE(pl.bungie_global_display_name, pp.display_name) as displayName,
            pl.bungie_global_display_name as bungieGlobalDisplayName,
            pl.bungie_global_display_name_code as bungieGlobalDisplayNameCode,
            COUNT(DISTINCT pp.instance_id) as completions
          FROM pgcr_players pp
          JOIN pgcrs p ON pp.instance_id = p.instance_id
          LEFT JOIN players pl ON pp.membership_id = pl.membership_id
          WHERE p.period >= ?
            AND pp.completed = 1
            AND p.completed = 1
            AND p.raid_key = ?
        `;

                const params: any[] = [cutoff, raidKey];

                if (fullClearsOnly) {
                    query += ` AND p.activity_was_started_from_beginning = 1`;
                }

                query += `
          GROUP BY pp.membership_id
          HAVING completions > 0
          ORDER BY completions DESC
          LIMIT ?
        `;
                params.push(limit);

                const entries = db.prepare(query).all(...params) as any[];

                const raidName = allRaids[raidKey]?.name || raidKey;

                leaderboards[raidKey] = {
                    raidKey,
                    raidName,
                    entries: entries.map((e) => ({
                        membershipId: e.membershipId,
                        membershipType: e.membershipType,
                        displayName: formatDisplayName(e),
                        completions: e.completions,
                    })),
                };
            }

            return NextResponse.json({
                mode: 'individual',
                hours,
                fullClearsOnly,
                raidKeys,
                leaderboards,
            });
        } else {
            // Aggregate mode — total clears across all selected raids
            let query = `
        SELECT
          pp.membership_id as membershipId,
          pp.membership_type as membershipType,
          COALESCE(pl.bungie_global_display_name, pp.display_name) as displayName,
          pl.bungie_global_display_name as bungieGlobalDisplayName,
          pl.bungie_global_display_name_code as bungieGlobalDisplayNameCode,
          COUNT(DISTINCT pp.instance_id) as completions
        FROM pgcr_players pp
        JOIN pgcrs p ON pp.instance_id = p.instance_id
        LEFT JOIN players pl ON pp.membership_id = pl.membership_id
        WHERE p.period >= ?
          AND pp.completed = 1
          AND p.completed = 1
      `;

            const params: any[] = [cutoff];

            // Filter to selected raids if any are specified
            if (raidKeys.length > 0) {
                const placeholders = raidKeys.map(() => '?').join(',');
                query += ` AND p.raid_key IN (${placeholders})`;
                params.push(...raidKeys);
            }

            if (fullClearsOnly) {
                query += ` AND p.activity_was_started_from_beginning = 1`;
            }

            query += `
        GROUP BY pp.membership_id
        HAVING completions > 0
        ORDER BY completions DESC
        LIMIT ?
      `;
            params.push(limit);

            const entries = db.prepare(query).all(...params) as any[];

            return NextResponse.json({
                mode: 'aggregate',
                hours,
                fullClearsOnly,
                raidKeys: raidKeys.length > 0 ? raidKeys : Object.keys(allRaids),
                entries: entries.map((e) => ({
                    membershipId: e.membershipId,
                    membershipType: e.membershipType,
                    displayName: formatDisplayName(e),
                    completions: e.completions,
                })),
            });
        }
    } catch (error) {
        console.error('[ERROR] Leaderboard query failed:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

function formatDisplayName(entry: any): string {
    if (entry.bungieGlobalDisplayName && entry.bungieGlobalDisplayNameCode) {
        return `${entry.bungieGlobalDisplayName}#${String(entry.bungieGlobalDisplayNameCode).padStart(4, '0')}`;
    }
    return entry.bungieGlobalDisplayName || entry.displayName || entry.membershipId;
}
