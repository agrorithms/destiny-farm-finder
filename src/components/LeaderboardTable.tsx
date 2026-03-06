'use client';

interface LeaderboardEntry {
    membershipId: string;
    membershipType: number;
    displayName: string;
    completions: number;
}

interface LeaderboardTableProps {
    entries: LeaderboardEntry[];
    loading?: boolean;
    title?: string;
    showRaidColumn?: boolean;
    raidName?: string;
}

export default function LeaderboardTable({
    entries,
    loading = false,
    title,
    showRaidColumn = false,
    raidName,
}: LeaderboardTableProps) {
    if (loading) {
        return (
            <div className="space-y-2">
                {title && <h3 className="text-lg font-bold text-gray-200 mb-3">{title}</h3>}
                {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="h-10 bg-gray-800 rounded animate-pulse" />
                ))}
            </div>
        );
    }

    if (entries.length === 0) {
        return (
            <div className="text-center py-12 text-gray-400">
                {title && <h3 className="text-lg font-bold text-gray-200 mb-3">{title}</h3>}
                <p className="text-lg">No completions found</p>
                <p className="text-sm mt-1">Try adjusting the time range or raid filter</p>
            </div>
        );
    }

    return (
        <div>
            {title && <h3 className="text-lg font-bold text-gray-200 mb-3">{title}</h3>}
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-gray-700 text-gray-400">
                            <th className="text-left py-3 px-2 w-12">#</th>
                            <th className="text-left py-3 px-2">Player</th>
                            {showRaidColumn && <th className="text-left py-3 px-2">Raid</th>}
                            <th className="text-right py-3 px-2 w-24">Clears</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entries.map((entry, index) => (
                            <tr
                                key={entry.membershipId}
                                className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors"
                            >
                                <td className="py-2.5 px-2 text-gray-500">
                                    {index < 3 ? (
                                        <span className={`font-bold ${index === 0 ? 'text-yellow-400' :
                                                index === 1 ? 'text-gray-300' :
                                                    'text-amber-600'
                                            }`}>
                                            {index + 1}
                                        </span>
                                    ) : (
                                        index + 1
                                    )}
                                </td>
                                <td className="py-2.5 px-2">
                                    <a
                                        href={`https://raid.report/${getMembershipPrefix(entry.membershipType)}/${entry.membershipId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-gray-200 hover:text-blue-400 transition-colors"
                                    >
                                        {entry.displayName}
                                    </a>
                                </td>
                                {showRaidColumn && (
                                    <td className="py-2.5 px-2 text-gray-400">{raidName}</td>
                                )}
                                <td className="py-2.5 px-2 text-right font-mono font-bold text-gray-200">
                                    {entry.completions}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function getMembershipPrefix(membershipType: number): string {
    switch (membershipType) {
        case 1: return 'xb';
        case 2: return 'ps';
        case 3: return 'pc';
        case 5: return 'stadia';
        case 6: return 'epic';
        default: return 'pc';
    }
}
