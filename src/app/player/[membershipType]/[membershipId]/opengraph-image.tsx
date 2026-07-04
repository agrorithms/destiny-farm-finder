import { ImageResponse } from 'next/og';
import { getPlayerOgData, MOST_FARMED_WINDOW_DAYS } from '@/lib/og/player-card';
import {
    OG_SIZE_PLAYER,
    OG_CONTENT_TYPE,
    OG_ACCENT,
    OG_BG,
    OG_MUTED,
    OG_SUBTITLE,
    Wordmark,
} from '@/lib/og/branded-card';

// better-sqlite3 is a native Node module and cannot run on the edge runtime.
export const runtime = 'nodejs';
// Refresh the generated card at most hourly (Discord/Slack cache unfurls aggressively too).
export const revalidate = 3600;

export const size = OG_SIZE_PLAYER;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Destiny Farm Finder player card';

export default async function Image({
    params,
}: {
    params: Promise<{ membershipType: string; membershipId: string }>;
}) {
    const { membershipId } = await params;

    let data: ReturnType<typeof getPlayerOgData> = null;
    try {
        data = getPlayerOgData(membershipId);
    } catch {
        data = null;
    }

    const name = data?.displayName ?? 'Guardian';
    const totalClears = data?.totalClears ?? 0;
    const topRaidName = data?.topRaidName ?? null;
    const topRaidCount = data?.topRaidCount ?? 0;

    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '48px',
                    background: `radial-gradient(circle at 20% 0%, #1a2030 0%, ${OG_BG} 55%)`,
                    padding: '64px 72px',
                    fontFamily: 'sans-serif',
                    color: '#ffffff',
                }}
            >
                <Wordmark />

                <div style={{ fontSize: '34px', color: OG_MUTED }}>{OG_SUBTITLE}</div>

                {/* Player name */}
                <div
                    style={{
                        fontSize: name.length > 22 ? '76px' : '96px',
                        fontWeight: 800,
                        lineHeight: 1.05,
                    }}
                >
                    {name}
                </div>

                {/* Stats row — flat (no boxed backgrounds), sitting on the card background */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '72px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div style={{ fontSize: '88px', fontWeight: 800, color: OG_ACCENT, lineHeight: 1 }}>
                            {totalClears.toLocaleString()}
                        </div>
                        <div style={{ fontSize: '28px', color: OG_MUTED, marginTop: '8px' }}>
                            full raid clears
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div style={{ fontSize: '24px', color: OG_MUTED }}>
                            {`Most cleared · last ${MOST_FARMED_WINDOW_DAYS} days`}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px', marginTop: '10px' }}>
                            <div style={{ fontSize: '46px', fontWeight: 700, lineHeight: 1.1 }}>
                                {topRaidName ?? 'No recent clears'}
                            </div>
                            {topRaidName ? (
                                <div style={{ fontSize: '46px', fontWeight: 800, color: OG_ACCENT, lineHeight: 1.1 }}>
                                    {` · ${topRaidCount}`}
                                </div>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
        ),
        { ...size }
    );
}
