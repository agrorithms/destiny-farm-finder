'use client';

interface PartyMember {
    membershipId: string;
    displayName: string;
    status: number;
}

interface ActiveSession {
    membershipId: string;
    displayName: string;
    activityHash: number;
    raidKey: string;
    raidName: string;
    startedAt: string;
    playerCount: number;
    partyMembers: PartyMember[];
}

interface ActiveSessionCardProps {
    session: ActiveSession;
}

function getElapsedTime(startedAt: string): string {
    const start = new Date(startedAt).getTime();
    const now = Date.now();
    const diffMs = now - start;

    if (diffMs < 0) return 'Just started';

    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours > 0) {
        return `${hours}h ${remainingMinutes}m`;
    }
    return `${minutes}m`;
}

export default function ActiveSessionCard({ session }: ActiveSessionCardProps) {
    return (
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 hover:border-gray-600 transition-colors">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-blue-400">
                    {session.raidName}
                </h3>
                <span className="text-xs text-gray-400">
                    {getElapsedTime(session.startedAt)} elapsed
                </span>
            </div>

            <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">
                    {session.playerCount} / 6 players
                </span>
                <div className="flex gap-1">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div
                            key={i}
                            className={`w-2 h-2 rounded-full ${i < session.playerCount ? 'bg-green-500' : 'bg-gray-600'
                                }`}
                        />
                    ))}
                </div>
            </div>

            <div className="space-y-1">
                {session.partyMembers.map((member) => (
                    <div
                        key={member.membershipId}
                        className="flex items-center gap-2 text-sm"
                    >
                        <div
                            className={`w-1.5 h-1.5 rounded-full ${member.status === 1 ? 'bg-green-500' : 'bg-gray-500'
                                }`}
                        />
                        <span className="text-gray-300 truncate">
                            {member.displayName || member.membershipId}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
