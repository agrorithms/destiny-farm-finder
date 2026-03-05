import { NextResponse } from 'next/server';
import { getAllRaidDefinitions } from '@/lib/bungie/manifest';

export async function GET() {
    const raids = getAllRaidDefinitions();

    const raidList = Object.entries(raids).map(([key, raid]) => ({
        key,
        name: raid.name,
        slug: raid.slug,
    }));

    return NextResponse.json({
        raids: raidList,
    });
}
