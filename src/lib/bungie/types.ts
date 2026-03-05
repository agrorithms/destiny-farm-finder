// ---- API Response Wrapper ----
export interface BungieResponse<T> {
    Response: T;
    ErrorCode: number;
    ThrottleSeconds: number;
    ErrorStatus: string;
    Message: string;
}

// ---- Profile / Characters ----
export interface DestinyProfileResponse {
    profile?: {
        data: {
            userInfo: UserInfoCard;
            characterIds: string[];
        };
    };
    characters?: {
        data: Record<string, DestinyCharacterComponent>;
    };
    profileTransitoryData?: {
        data: TransitoryComponent | null;
    };
    characterActivities?: {
        data: Record<string, CharacterActivitiesComponent>;
    };
}

export interface UserInfoCard {
    membershipType: number;
    membershipId: string;
    displayName: string;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
}

export interface DestinyCharacterComponent {
    characterId: string;
    classType: number;
    light: number;
}

export interface CharacterActivitiesComponent {
    currentActivityHash: number;
    currentActivityModeHash: number;
    currentActivityModeType: number;
    dateActivityStarted: string;
}

// ---- Activity History ----
export interface DestinyActivityHistoryResults {
    activities?: DestinyHistoricalStatsPeriodGroup[];
}

export interface DestinyHistoricalStatsPeriodGroup {
    period: string;
    activityDetails: {
        referenceId: number;
        instanceId: string;
        mode: number;
        modes: number[];
        directorActivityHash: number;
    };
    values: Record<string, DestinyHistoricalStatsValue>;
}

export interface DestinyHistoricalStatsValue {
    statId?: string;
    basic: {
        value: number;
        displayValue: string;
    };
}

// ---- PGCR ----
export interface DestinyPostGameCarnageReportData {
    period: string;
    startingPhaseIndex: number;
    activityWasStartedFromBeginning: boolean;
    activityDetails: {
        referenceId: number;
        directorActivityHash: number;
        instanceId: string;
        mode: number;
        modes: number[];
    };
    entries: DestinyPostGameCarnageReportEntry[];
}

export interface DestinyPostGameCarnageReportEntry {
    standing: number;
    player: {
        destinyUserInfo: UserInfoCard;
        characterClass: string;
        characterLevel: number;
        lightLevel: number;
    };
    values: Record<string, DestinyHistoricalStatsValue>;
}

// ---- Transitory ----
export interface TransitoryComponent {
    partyMembers: TransitoryPartyMember[];
    currentActivity: TransitoryCurrentActivity;
    joinability: {
        openSlots: number;
        privacySetting: number;
        closedReasons: number;
    };
}

export interface TransitoryPartyMember {
    membershipId: string;
    emblemHash: number;
    displayName: string;
    status: number;
}

export interface TransitoryCurrentActivity {
    startTime: string;
    endTime: string;
    score: number;
    highestOpposingFactionScore: number;
    numberOfOpponents: number;
    numberOfPlayers: number;
    currentActivityHash: number;
    currentActivityModeHash: number;
    currentActivityModeType: number;
    currentPlaylistActivityHash: number;
}

// ---- Internal Types ----
export interface PlayerInfo {
    membershipId: string;
    membershipType: number;
    displayName: string;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
    lastCrawledAt?: number;
    raidCompletions?: number;
}

export interface RaidSession {
    sessionKey: string;
    activityHash: number;
    raidName: string;
    raidKey: string;
    players: TransitoryPartyMember[];
    startedAt: string;
    playerCount: number;
}

export interface LeaderboardEntry {
    membershipId: string;
    membershipType: number;
    displayName: string;
    bungieGlobalDisplayName?: string;
    completions: number;
    raidName: string;
}
