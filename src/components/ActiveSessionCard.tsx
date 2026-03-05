'use client';

interface LeaderboardEntry {
    membershipId: string;
    membershipType: number;
    displayName: string;
    bungieGlobalDisplayName?: string;
    completions: number;
    raidName?: string;
}

interface LeaderboardTableProps {
    entries: LeaderboardEntry[];
    loading?: boolean;
    raidKey?: string;
}

export default function LeaderboardTable({
    entries,
    loading = false,
    raidKey,
}: LeaderboardTableProps) {
    if (loading) {
        return (
            <div className="space-y-2">
                {Array.from({ length: 10 }).map((_, i) => (
                    <div
                        key={i}
                        className="h-12 bg-gray-800 rounded animate-pulse"
                    />
                ))}
            </div>
        );
    }

    if (entries.length === 0) {
        return (
            <div className="text-center py-12 text-gray-400">
                <p className="text-lg">No completions found</p>
                <p className="text-sm mt-2">
                    Try expanding the time window or running the discovery tool to find more players.
                </p>
            </div>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-left">
                <thead>
                    <tr className="border-b border-gray-700">
                        <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-16">
                            Rank
                        </th>
                        <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                            Player
                        </th>
                        {raidKey === 'all' && (
                            <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                                Raid
                            </th>
                        )}
                        <th className="px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider text-right w-32">
                            Clears
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                    {entries.map((entry, index) => (
                        <tr
                            key={entry.membershipId}
                            className="hover:bg-gray-800/50 transition-colors"
                        >
                            <td className="px-4 py-3">
                                <span
                                    className={`text-sm font-bold ${index === 0
                                            ? 'text-yellow-400'
                                            : index === 1
                                                ? 'text-gray-300'
                                                : index === 2
                                                    ? 'text-amber-600'
                                                    : 'text-gray-500'
                                        }`}
                                >
                                    {index + 1}
                                </span>
                            </td>
                            <td className="px-4 py-3">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium text-white">
                                        {entry.bungieGlobalDisplayName || entry.displayName}
                                    </span>
                                    <span className="text-xs text-gray-500">
                                        {entry.membershipId}
                                    </span>
                                </div>
                            </td>
                            {raidKey === 'all' && (
                                <td className="px-4 py-3 text-sm text-gray-300">
                                    {entry.raidName || 'Unknown'}
                                </td>
                            )}
                            <td className="px-4 py-3 text-right">
                                <span className="text-lg font-bold text-blue-400">
                                    {entry.completions}
                                </span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
