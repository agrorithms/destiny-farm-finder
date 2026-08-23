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
        data?: {
            userInfo: UserInfoCard;
            characterIds: string[];
        };
        privacy?: number;
    };
    characters?: {
        data?: Record<string, DestinyCharacterComponent>;
        privacy?: number;
    };
    profileTransitoryData?: {
        data?: TransitoryComponent | null;
        privacy?: number;
    };
    characterActivities?: {
        // A withheld (private) component arrives as `{ privacy: 2 }` with no `data`.
        data?: Record<string, CharacterActivitiesComponent>;
        privacy?: number;
    };
}

export interface UserInfoCard {
    membershipType: number;
    membershipId: string;
    displayName: string;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
    isPublic?: boolean;
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
    activityDifficultyTier?: number;
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

// ---- Manifest / Search ----
export interface DestinyManifestResponse {
    jsonWorldComponentContentPaths: {
        en: {
            DestinyActivityDefinition: string;
        };
    };
}

export interface DestinyActivityDefinition {
    activityTypeHash?: number;
    activityModeTypes?: number[];
    displayProperties?: {
        name?: string;
        description?: string;
    };
    directActivityModeType?: number;
}

export interface DestinyUserSearchMembership {
    membershipId?: string;
    membershipType?: number;
    displayName?: string;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
    crossSaveOverride?: number;
    applicableMembershipTypes?: number[];
}

export interface DestinyUserSearchResult extends DestinyUserSearchMembership {
    destinyMemberships?: DestinyUserSearchMembership[];
}

export type DestinyUserSearchResponse =
    | DestinyUserSearchResult[]
    | {
        searchResults?: DestinyUserSearchResult[];
    };

export type DestinyExactPlayerSearchResponse = DestinyUserSearchMembership[];

// ---- Linked Profiles (GetLinkedProfiles) ----
// Resolves a membershipId-only identity to Name#Code + the platform membershipType.
export interface DestinyLinkedProfile {
    membershipId: string;
    membershipType: number;
    displayName?: string;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
    isCrossSavePrimary?: boolean;
    applicableMembershipTypes?: number[];
    isPublic?: boolean;
}

export interface DestinyLinkedProfilesResponse {
    profiles?: DestinyLinkedProfile[];
    bnetMembership?: {
        membershipId?: string;
        bungieGlobalDisplayName?: string;
        bungieGlobalDisplayNameCode?: number;
    };
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
    activityModeHash: number | null;
    activityModeType: number | null;
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
