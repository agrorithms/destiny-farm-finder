import type { DestinyLinkedProfilesResponse, DestinyProfileResponse } from '../../src/lib/bungie/types';

// Salvation's Edge normal — a real hash from RAID_DEFINITIONS so parseAndStoreActivity
// processes it instead of silently returning 'inactive'.
const DEFAULT_RAID_HASH = 2192826039;

const DEFAULT_MEMBERSHIP_ID = '4611686018488400001';
const DEFAULT_MEMBERSHIP_TYPE = 3;
const DEFAULT_CHARACTER_ID = '2305843009999900001';

function defaultStartTime(): string {
    return new Date(Date.now() - 30 * 60_000).toISOString();
}

export interface ProfileOverrides {
    membershipId?: string;
    membershipType?: number;
    displayName?: string;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
    isPublic?: boolean;
    characterId?: string;
    activityHash?: number;
    activityModeHash?: number;
    activityModeType?: number;
    dateActivityStarted?: string;
    startTime?: string;
    numberOfPlayers?: number;
    partyMembers?: Array<{ membershipId: string; emblemHash?: number; displayName?: string; status?: number }>;
    withTransitoryData?: boolean;
}

type PartyMemberInput = NonNullable<ProfileOverrides['partyMembers']>[number];

function toTransitoryPartyMembers(members: PartyMemberInput[]) {
    return members.map((m) => ({
        membershipId: m.membershipId,
        emblemHash: m.emblemHash ?? 0,
        displayName: m.displayName ?? m.membershipId,
        status: m.status ?? 1,
    }));
}

export function buildActiveProfile(overrides: ProfileOverrides = {}): DestinyProfileResponse {
    const membershipId = overrides.membershipId ?? DEFAULT_MEMBERSHIP_ID;
    const membershipType = overrides.membershipType ?? DEFAULT_MEMBERSHIP_TYPE;
    const characterId = overrides.characterId ?? DEFAULT_CHARACTER_ID;
    const activityHash = overrides.activityHash ?? DEFAULT_RAID_HASH;
    const startTime = overrides.dateActivityStarted ?? overrides.startTime ?? defaultStartTime();
    const partyMembers = overrides.partyMembers ?? [
        { membershipId, emblemHash: 0, displayName: overrides.displayName ?? 'TestGuardian', status: 1 },
    ];

    return {
        profile: {
            data: {
                userInfo: {
                    membershipId,
                    membershipType,
                    displayName: overrides.displayName ?? 'TestGuardian',
                    bungieGlobalDisplayName: overrides.bungieGlobalDisplayName ?? 'TestGuardian',
                    bungieGlobalDisplayNameCode: overrides.bungieGlobalDisplayNameCode ?? 1234,
                    isPublic: overrides.isPublic ?? true,
                },
                characterIds: [characterId],
            },
        },
        characterActivities: {
            data: {
                [characterId]: {
                    currentActivityHash: activityHash,
                    currentActivityModeHash: overrides.activityModeHash ?? 0,
                    currentActivityModeType: overrides.activityModeType ?? 4,
                    dateActivityStarted: startTime,
                },
            },
        },
        profileTransitoryData: {
            data: {
                partyMembers: toTransitoryPartyMembers(partyMembers),
                currentActivity: {
                    startTime,
                    endTime: '',
                    score: 0,
                    highestOpposingFactionScore: 0,
                    numberOfOpponents: 0,
                    numberOfPlayers: overrides.numberOfPlayers ?? partyMembers.length,
                    currentActivityHash: activityHash,
                    currentActivityModeHash: overrides.activityModeHash ?? 0,
                    currentActivityModeType: overrides.activityModeType ?? 4,
                    currentPlaylistActivityHash: 0,
                },
                joinability: { openSlots: 0, privacySetting: 0, closedReasons: 0 },
            },
        },
    };
}

export function buildPrivateProfile(overrides: ProfileOverrides = {}): DestinyProfileResponse {
    const membershipId = overrides.membershipId ?? DEFAULT_MEMBERSHIP_ID;
    const membershipType = overrides.membershipType ?? DEFAULT_MEMBERSHIP_TYPE;
    const startTime = overrides.startTime ?? defaultStartTime();
    const partyMembers = overrides.partyMembers ?? [
        { membershipId, emblemHash: 0, displayName: overrides.displayName ?? 'PrivateGuardian', status: 1 },
    ];

    const withTransitory = overrides.withTransitoryData !== false;

    return {
        profile: {
            data: {
                userInfo: {
                    membershipId,
                    membershipType,
                    displayName: overrides.displayName ?? 'PrivateGuardian',
                    bungieGlobalDisplayName: overrides.bungieGlobalDisplayName ?? 'PrivateGuardian',
                    bungieGlobalDisplayNameCode: overrides.bungieGlobalDisplayNameCode ?? 5678,
                    isPublic: false,
                },
                characterIds: [overrides.characterId ?? DEFAULT_CHARACTER_ID],
            },
        },
        characterActivities: {
            privacy: 2,
        },
        profileTransitoryData: withTransitory
            ? {
                data: {
                    partyMembers: toTransitoryPartyMembers(partyMembers),
                    currentActivity: {
                        startTime,
                        endTime: '',
                        score: 0,
                        highestOpposingFactionScore: 0,
                        numberOfOpponents: 0,
                        numberOfPlayers: overrides.numberOfPlayers ?? partyMembers.length,
                        currentActivityHash: overrides.activityHash ?? 0,
                        currentActivityModeHash: overrides.activityModeHash ?? 0,
                        currentActivityModeType: overrides.activityModeType ?? 0,
                        currentPlaylistActivityHash: 0,
                    },
                    joinability: { openSlots: 0, privacySetting: 0, closedReasons: 0 },
                },
            }
            : { data: null },
    };
}

export function buildInactiveProfile(overrides: ProfileOverrides = {}): DestinyProfileResponse {
    const membershipId = overrides.membershipId ?? DEFAULT_MEMBERSHIP_ID;
    const membershipType = overrides.membershipType ?? DEFAULT_MEMBERSHIP_TYPE;

    return {
        profile: {
            data: {
                userInfo: {
                    membershipId,
                    membershipType,
                    displayName: overrides.displayName ?? 'InactiveGuardian',
                    bungieGlobalDisplayName: overrides.bungieGlobalDisplayName ?? 'InactiveGuardian',
                    bungieGlobalDisplayNameCode: overrides.bungieGlobalDisplayNameCode ?? 9012,
                    isPublic: overrides.isPublic ?? true,
                },
                characterIds: [overrides.characterId ?? DEFAULT_CHARACTER_ID],
            },
        },
        characterActivities: {
            data: {},
        },
        profileTransitoryData: {
            data: null,
        },
    };
}

// ---- Wire envelope + LinkedProfiles ----
// Kept here rather than in a spec so both runners agree on what Bungie sends.
// A second, hand-rolled copy of these shapes is exactly the drift this module exists
// to prevent — see tests/README.md, "Fixtures or builders?".

export interface BungieEnvelopeOverrides {
    ErrorCode?: number;
    ErrorStatus?: string;
    Message?: string;
}

/** The `{ ErrorCode, Response }` wrapper every Bungie platform response arrives in. */
export function bungieEnvelope(response: unknown, overrides: BungieEnvelopeOverrides = {}) {
    return {
        ErrorCode: overrides.ErrorCode ?? 1,
        ErrorStatus: overrides.ErrorStatus ?? 'Success',
        Message: overrides.Message ?? 'Ok',
        ThrottleSeconds: 0,
        Response: response,
    };
}

export interface LinkedProfileOverrides {
    membershipId?: string;
    membershipType?: number;
    displayName?: string;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
    isCrossSavePrimary?: boolean;
    isPublic?: boolean;
}

/**
 * A GetLinkedProfiles response for a single account, shaped so
 * pickPrimaryLinkedProfile resolves it by exact membershipId match.
 */
export function buildLinkedProfiles(overrides: LinkedProfileOverrides = {}): DestinyLinkedProfilesResponse {
    const membershipId = overrides.membershipId ?? DEFAULT_MEMBERSHIP_ID;
    const membershipType = overrides.membershipType ?? DEFAULT_MEMBERSHIP_TYPE;
    const name = overrides.bungieGlobalDisplayName ?? overrides.displayName ?? 'TestGuardian';
    const code = overrides.bungieGlobalDisplayNameCode ?? 1234;

    return {
        profiles: [
            {
                membershipId,
                membershipType,
                displayName: overrides.displayName ?? name,
                bungieGlobalDisplayName: name,
                bungieGlobalDisplayNameCode: code,
                isCrossSavePrimary: overrides.isCrossSavePrimary ?? true,
                applicableMembershipTypes: [membershipType],
                isPublic: overrides.isPublic ?? true,
            },
        ],
        bnetMembership: {
            membershipId,
            bungieGlobalDisplayName: name,
            bungieGlobalDisplayNameCode: code,
        },
    };
}
