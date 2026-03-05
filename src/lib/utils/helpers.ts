/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert an ISO date string to a Unix timestamp (seconds)
 */
export function isoToUnix(isoString: string): number {
    return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * Get a Unix timestamp (seconds) for N hours ago
 */
export function hoursAgo(hours: number): number {
    return Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);
}

/**
 * Format a Unix timestamp to a human-readable string
 */
export function formatTimestamp(unix: number): string {
    return new Date(unix * 1000).toLocaleString();
}

/**
 * Truncate a string to a max length
 */
export function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + '...';
}