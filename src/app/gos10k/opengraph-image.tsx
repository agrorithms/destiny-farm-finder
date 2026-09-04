import { ImageResponse } from 'next/og';
import { brandedCard, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og/branded-card';
import { getArchiveOverview } from '@/lib/db/archive/queries';

export const runtime = 'nodejs';

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'The GoS 10k — 10,000 Garden of Salvation full clears';

// Rendered per request, not baked. The dataset is frozen so there is nothing to
// revalidate *for*, but `revalidate = false` would make this a static route and Next
// would generate it at build time — which is exactly the build-reads-the-Archive
// coupling ADR 0007 rejected, and would need the 63 MB file present in CI. The
// middleware cache header covers this path too, so it is served from cache in practice.
export const dynamic = 'force-dynamic';

export default function Image() {
    // A missing Archive must not take the unfurl down with it — a link that renders no
    // card is worse than one whose card is missing a number, and the page itself already
    // fails loudly (ADR 0007).
    let clears = 10000;
    let helpers = 5455;
    try {
        const overview = getArchiveOverview();
        clears = overview.pinnedFullClears;
        helpers = overview.helpers;
    } catch {
        // Keep the published figures.
    }

    return new ImageResponse(
        brandedCard({
            subtitle: 'A complete archive of one Guardian’s Garden of Salvation history.',
            topTitle: 'The GoS 10k',
            stats: [
                { value: clears.toLocaleString(), label: 'full clears' },
                { value: helpers.toLocaleString(), label: 'guardians who helped' },
            ],
        }),
        { ...size }
    );
}
