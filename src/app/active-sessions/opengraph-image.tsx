import { ImageResponse } from 'next/og';
import { brandedCard, OG_SIZE, OG_CONTENT_TYPE, OG_SUBTITLE } from '@/lib/og/branded-card';
import { countActiveRaidSessions } from '@/lib/active-session/dedupe';

export const runtime = 'nodejs';
// Live count — refresh more often than the static cards.
export const revalidate = 300;

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Destiny Farm Finder active raid sessions';

export default function Image() {
    const count = countActiveRaidSessions();

    return new ImageResponse(
        brandedCard({
            subtitle: OG_SUBTITLE,
            topTitle: 'Active Raid Sessions',
            stats: [
                {
                    value: count.toLocaleString(),
                    label: count === 1 ? 'fireteam raiding now' : 'fireteams raiding now',
                },
            ],
        }),
        { ...size }
    );
}
