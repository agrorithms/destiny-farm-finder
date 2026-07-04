'use client';

import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_KEY = 'destiny-farm-finder-theme';

function isThemePreference(value: string | null): value is ThemePreference {
    return value === 'light' || value === 'dark' || value === 'system';
}

function applyTheme(preference: ThemePreference) {
    const dark = preference === 'dark'
        || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
}

/**
 * Persisted theme preference. Defaults to 'system'.
 * The initial .dark class is set before paint by the inline script in layout.tsx;
 * this hook keeps it in sync afterwards (including live OS changes in system mode).
 */
export function useTheme(): [ThemePreference, (theme: ThemePreference) => void] {
    const [theme, setThemeState] = useState<ThemePreference>(() => {
        if (typeof window === 'undefined') {
            return 'system';
        }
        try {
            const stored = localStorage.getItem(THEME_KEY);
            if (isThemePreference(stored)) {
                return stored;
            }
        } catch {
            // Ignore
        }
        return 'system';
    });

    useEffect(() => {
        applyTheme(theme);
        try {
            localStorage.setItem(THEME_KEY, theme);
        } catch {
            // Ignore
        }
    }, [theme]);

    // In system mode, follow live OS preference changes.
    useEffect(() => {
        if (theme !== 'system') {
            return;
        }
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => applyTheme('system');
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    }, [theme]);

    const setTheme = useCallback((next: ThemePreference) => {
        setThemeState(next);
    }, []);

    return [theme, setTheme];
}
