import type { ReactElement } from 'react';

// Card sizes. All cards share the 1200 width and identical styling/padding so the set looks
// uniform; the content-rich player card is a little taller than the utility cards so none of
// them carries a large empty bottom gap. ~2:1–2.4:1 still renders as a large image card on
// Discord/Slack/iMessage/Twitter.
const OG_WIDTH = 1200;
export const OG_SIZE = { width: OG_WIDTH, height: 520 }; // sessions / leaderboard / root
export const OG_SIZE_PLAYER = { width: OG_WIDTH, height: 590 };
export const OG_CONTENT_TYPE = 'image/png';

// Site tagline shown directly under the wordmark on every card.
export const OG_SUBTITLE = 'Live raid completion leaderboards and active fireteam sessions.';

export const OG_ACCENT = '#f5c542';
export const OG_BG = '#0b0e14';
export const OG_MUTED = '#8a93a6';

interface CardStat {
    value: string;
    label: string;
}

interface BrandedCardOptions {
    /** Muted tagline rendered directly under the wordmark, above page-specific content. */
    subtitle?: string;
    /** Large title rendered under the subtitle. */
    topTitle?: string;
    /** One or more stat rows (big accent number + muted label). */
    stats?: CardStat[];
}

/** The "DESTINY FARM FINDER" wordmark used at the top of every card. */
export function Wordmark(): ReactElement {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ width: '14px', height: '44px', background: OG_ACCENT, borderRadius: '4px' }} />
            <div style={{ fontSize: '30px', fontWeight: 700, letterSpacing: '0.18em', color: OG_ACCENT }}>
                DESTINY FARM FINDER
            </div>
        </div>
    );
}

function StatRow({ value, label }: CardStat): ReactElement {
    return (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '20px' }}>
            <div style={{ fontSize: '92px', fontWeight: 800, color: OG_ACCENT, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: '34px', color: OG_MUTED }}>{label}</div>
        </div>
    );
}

/**
 * Shared top-aligned OG card frame for non per-player pages (home, leaderboard, sessions).
 * Content flows wordmark → topTitle → stats → subtitle from the top, so cards with less
 * content stay visually consistent with the fuller ones rather than leaving a large gap.
 * Returns a `next/og`-compatible JSX tree (flexbox-only styling).
 */
export function brandedCard({ subtitle, topTitle, stats }: BrandedCardOptions): ReactElement {
    return (
        <div
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: '40px',
                background: `radial-gradient(circle at 20% 0%, #1a2030 0%, ${OG_BG} 55%)`,
                padding: '64px 72px',
                fontFamily: 'sans-serif',
                color: '#ffffff',
            }}
        >
            <Wordmark />

            {subtitle ? <div style={{ fontSize: '34px', color: OG_MUTED }}>{subtitle}</div> : null}

            {topTitle ? (
                <div style={{ fontSize: '76px', fontWeight: 800, lineHeight: 1.05 }}>{topTitle}</div>
            ) : null}

            {stats && stats.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {stats.map((stat, i) => (
                        <StatRow key={i} value={stat.value} label={stat.label} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
