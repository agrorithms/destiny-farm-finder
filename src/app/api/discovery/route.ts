import { NextRequest, NextResponse } from 'next/server';
import { runDiscovery } from '@/lib/discovery/snowball';
import { getAllRaidDefinitions } from '@/lib/bungie/manifest';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        const {
            seedPlayers,
            maxDepth = 2,
            maxPlayers = 500,
            hoursBack = 4,
            raidFilter,
        } = body;

        // Validate seed players
        if (!seedPlayers || !Array.isArray(seedPlayers) || seedPlayers.length === 0) {
            return NextResponse.json(
                {
                    error: 'seedPlayers is required and must be a non-empty array',
                    example: [{ membershipId: '4611686018469615924', membershipType: 3 }],
                },
                { status: 400 }
            );
        }

        for (const player of seedPlayers) {
            if (!player.membershipId || !player.membershipType) {
                return NextResponse.json(
                    {
                        error: 'Each seed player must have membershipId and membershipType',
                        example: { membershipId: '4611686018469615924', membershipType: 3 },
                    },
                    { status: 400 }
                );
            }
        }

        // Validate raid filter
        if (raidFilter) {
            const raids = getAllRaidDefinitions();
            if (!raids[raidFilter]) {
                return NextResponse.json(
                    { error: `Unknown raid key: ${raidFilter}`, validKeys: Object.keys(raids) },
                    { status: 400 }
                );
            }
        }

        // Validate numeric params
        if (maxDepth < 1 || maxDepth > 5) {
            return NextResponse.json({ error: 'maxDepth must be between 1 and 5' }, { status: 400 });
        }
        if (maxPlayers < 10 || maxPlayers > 5000) {
            return NextResponse.json({ error: 'maxPlayers must be between 10 and 5000' }, { status: 400 });
        }
        if (hoursBack < 1 || hoursBack > 24) {
            return NextResponse.json({ error: 'hoursBack must be between 1 and 24' }, { status: 400 });
        }

        console.log('[DISCOVERY] Triggered via API:', {
            seedCount: seedPlayers.length,
            maxDepth,
            maxPlayers,
            hoursBack,
            raidFilter,
        });

        const result = await runDiscovery(seedPlayers, {
            maxDepth,
            maxPlayers,
            hoursBack,
            raidFilter,
        });

        return NextResponse.json({
            success: true,
            result,
        });
    } catch (error) {
        console.error('[ERROR] Discovery failed:', error);
        return NextResponse.json(
            { error: 'Discovery failed. Check server logs for details.' },
            { status: 500 }
        );
    }
}
