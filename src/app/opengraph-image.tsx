import { ImageResponse } from 'next/og';
import { brandedCard, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og/branded-card';
import { countActiveRaidSessions } from '@/lib/active-session/dedupe';
import { getFullClearCount } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const revalidate = 300;

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Destiny Farm Finder — real-time Destiny 2 raid tracking';

export default function Image() {
    const sessions = countActiveRaidSessions();
    let clears = 0;
    try {
        clears = getFullClearCount(24);
    } catch {
        clears = 0;
    }

    return new ImageResponse(
        brandedCard({
            stats: [
                { value: sessions.toLocaleString(), label: 'Fireteams Raiding Now' },
                { value: clears.toLocaleString(), label: 'Full Clears in 24h' },
            ],
            subtitle: 'Live raid completion leaderboards and active fireteam sessions.',
        }),
        { ...size }
    );
}
