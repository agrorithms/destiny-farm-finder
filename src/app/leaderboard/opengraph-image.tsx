import { ImageResponse } from 'next/og';
import { brandedCard, OG_SIZE, OG_CONTENT_TYPE, OG_SUBTITLE } from '@/lib/og/branded-card';
import { getFullClearCount } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const revalidate = 300;

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Destiny Farm Finder raid leaderboard';

export default function Image() {
    let clears = 0;
    try {
        clears = getFullClearCount(24);
    } catch {
        clears = 0;
    }

    return new ImageResponse(
        brandedCard({
            subtitle: OG_SUBTITLE,
            topTitle: 'Raid Leaderboard',
            stats: [{ value: clears.toLocaleString(), label: 'full clears · last 24h' }],
        }),
        { ...size }
    );
}
