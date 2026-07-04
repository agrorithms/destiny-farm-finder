import type { Metadata } from 'next';
import { getPlayerOgData, MOST_FARMED_WINDOW_DAYS } from '@/lib/og/player-card';

interface PlayerLayoutParams {
    membershipType: string;
    membershipId: string;
}

export async function generateMetadata({
    params,
}: {
    params: Promise<PlayerLayoutParams>;
}): Promise<Metadata> {
    const { membershipId } = await params;

    let data: ReturnType<typeof getPlayerOgData> = null;
    try {
        data = getPlayerOgData(membershipId);
    } catch {
        // DB maintenance / unexpected error — fall back to generic copy below.
        data = null;
    }

    if (!data) {
        const title = 'Guardian Profile — Destiny Farm Finder';
        const description = 'Live Destiny 2 raid completion tracking on Destiny Farm Finder.';
        return {
            title,
            description,
            openGraph: { title, description },
            twitter: { card: 'summary_large_image', title, description },
        };
    }

    const title = `${data.displayName} — ${data.totalClears.toLocaleString()} raid clears`;
    const description = data.topRaidName
        ? `Most cleared (${MOST_FARMED_WINDOW_DAYS}d): ${data.topRaidName} ×${data.topRaidCount} · Live raid tracking on Destiny Farm Finder.`
        : 'Live Destiny 2 raid completion tracking on Destiny Farm Finder.';

    return {
        title,
        description,
        // og:image / twitter:image are auto-wired by the sibling opengraph-image.tsx.
        openGraph: { title, description, type: 'profile' },
        twitter: { card: 'summary_large_image', title, description },
    };
}

export default function PlayerLayout({ children }: { children: React.ReactNode }) {
    return children;
}
