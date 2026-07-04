'use client';

import { useSyncExternalStore } from 'react';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';

const emptySubscribe = () => () => { };

const CYCLE: Record<ThemePreference, ThemePreference> = {
    light: 'dark',
    dark: 'system',
    system: 'light',
};

const LABELS: Record<ThemePreference, string> = {
    light: 'Theme: light',
    dark: 'Theme: dark',
    system: 'Theme: system',
};

function ThemeIcon({ theme }: { theme: ThemePreference }) {
    if (theme === 'light') {
        return (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
        );
    }
    if (theme === 'dark') {
        return (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
        );
    }
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8m-4-4v4" />
        </svg>
    );
}

export default function ThemeToggle() {
    const [theme, setTheme] = useTheme();
    // The stored preference is unknown during SSR; render a placeholder until
    // hydration so server and client markup match.
    const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

    if (!mounted) {
        return <span className="inline-block w-7 h-7" aria-hidden="true" />;
    }

    return (
        <button
            type="button"
            onClick={() => setTheme(CYCLE[theme])}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md border ui-divider ui-text-secondary hover:text-[var(--ui-text-primary)] hover:border-[var(--ui-border-strong)] transition-colors"
            aria-label={`${LABELS[theme]} — click to change`}
            title={LABELS[theme]}
        >
            <ThemeIcon theme={theme} />
        </button>
    );
}
