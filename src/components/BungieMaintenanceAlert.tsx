'use client';

import { useLiveStats } from '@/hooks/useLiveStats';

export default function BungieMaintenanceAlert() {
    const { stats } = useLiveStats();

    const isActive =
        stats?.bungieMaintenanceActive === true ||
        stats?.dbQuiesceActive === true ||
        stats?.maintenance === true;

    if (!isActive) {
        return null;
    }

    return (
        <div className="max-w-7xl mx-auto px-4 pt-4" role="status" aria-live="polite">
            <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                Bungie API is temporarily disabled for maintenance. No new data is being recorded.
            </p>
        </div>
    );
}
