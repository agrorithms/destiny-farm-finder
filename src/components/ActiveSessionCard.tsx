'use client';

interface PartyMember {
    membershipId: string;
    membershipType?: number;
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
    /** 'new' = appeared since the last refresh; 'ended' = gone from the latest poll, held one cycle before removal. */
    badge?: 'new' | 'ended';
}

function getDisplayName(member: PartyMember): string {
    return member.displayName || member.membershipId;
}

function getDisplayNameLength(member: PartyMember): number {
    return getDisplayName(member).length;
}

function compactPartyMembers(members: PartyMember[]): PartyMember[] {
    return [...members]
        .slice(0, 6)
        .map((member, index) => ({ member, index }))
        .sort((a, b) => {
            const lengthDelta = getDisplayNameLength(b.member) - getDisplayNameLength(a.member);
            if (lengthDelta !== 0) return lengthDelta;
            return a.index - b.index;
        })
        .map(({ member }) => member);
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

export default function ActiveSessionCard({ session, badge }: ActiveSessionCardProps) {
    const visibleMembers = compactPartyMembers(session.partyMembers);

    return (
        <div className="ui-card ui-card-hover p-4 hover:border-blue-300 dark:hover:border-gray-600">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-blue-400">
                    {session.raidName}
                </h3>
                <span className="flex items-center gap-2">
                    {badge === 'new' && (
                        <span
                            className="text-[0.65rem] font-semibold text-yellow-600 dark:text-yellow-400"
                            title="Appeared since the last refresh"
                        >
                            NEW
                        </span>
                    )}
                    {badge === 'ended' && (
                        <span
                            className="text-[0.65rem] font-semibold uppercase ui-text-muted"
                            title="No longer active — removed on the next refresh"
                        >
                            Ended
                        </span>
                    )}
                    <span className="text-xs ui-text-muted">
                        {getElapsedTime(session.startedAt)} elapsed
                    </span>
                </span>
            </div>

            <div className="flex items-center justify-between mb-3">
                <span className="text-xs ui-text-muted">
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

            <div className="grid grid-cols-1 gap-y-1 sm:grid-cols-2 sm:grid-flow-col sm:grid-rows-3 sm:gap-x-4">
                {visibleMembers.map((member) => {
                    const displayName = getDisplayName(member);
                    const href = typeof member.membershipType === 'number'
                        ? `/player/${member.membershipType}/${member.membershipId}`
                        : null;

                    return (
                        <div
                            key={member.membershipId}
                            className="flex items-center gap-2 min-w-0 text-sm"
                        >
                            <div
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${member.status === 1 ? 'bg-green-500' : 'bg-gray-500'
                                    }`}
                            />
                            {href ? (
                                <a
                                    href={href}
                                    title={displayName}
                                    className="block min-w-0 truncate ui-text-primary hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                                >
                                    {displayName}
                                </a>
                            ) : (
                                <span
                                    title={displayName}
                                    className="block min-w-0 truncate ui-text-primary"
                                >
                                    {displayName}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
