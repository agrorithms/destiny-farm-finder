import type { DestinyLinkedProfilesResponse, DestinyProfileResponse } from '../../src/lib/bungie/types';
import { RAID_HASH } from './pgcr-builder';

/**
 * Salvation's Edge — re-exported from pgcr-builder so both builders name one
 * constant. A hash outside RAID_DEFINITIONS makes parseAndStoreActivity return
 * 'inactive', which is a confusing way for an active-session test to fail.
 */
export { RAID_HASH };

/** Bungie's mode type for a raid. Nothing under test varies it. */
const RAID_MODE_TYPE = 4;

const DEFAULT_MEMBERSHIP_ID = '4611686018488400001';
const DEFAULT_MEMBERSHIP_TYPE = 3;
const DEFAULT_CHARACTER_ID = '2305843009999900001';

function defaultStartTime(): string {
    return new Date(Date.now() - 30 * 60_000).toISOString();
}

/** Who the profile belongs to. Every preset honours all of these. */
export interface ProfileIdentityOverrides {
    membershipId?: string;
    membershipType?: number;
    displayName?: string;
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
}

export interface PartyMemberInput {
    membershipId: string;
    displayName?: string;
    status?: number;
}

export interface ActiveProfileOverrides extends ProfileIdentityOverrides {
    activityHash?: number;
    startTime?: string;
    partyMembers?: PartyMemberInput[];
}

export interface PrivateProfileOverrides extends ProfileIdentityOverrides {
    startTime?: string;
    partyMembers?: PartyMemberInput[];
    /**
     * Defaults to true. Set false for a private account Bungie tells us nothing
     * about — with transitory data present the route takes the *provisional
     * session* path instead, which is a different assertion.
     */
    withTransitoryData?: boolean;
}

/**
 * The presets below differ only in these two blocks plus the `characterActivities`
 * shape, so they are built once here rather than restated three times.
 */
function buildUserInfo(overrides: ProfileIdentityOverrides, fallbackName: string, code: number, isPublic: boolean) {
    const name = overrides.displayName ?? fallbackName;
    return {
        membershipId: overrides.membershipId ?? DEFAULT_MEMBERSHIP_ID,
        membershipType: overrides.membershipType ?? DEFAULT_MEMBERSHIP_TYPE,
        displayName: name,
        bungieGlobalDisplayName: overrides.bungieGlobalDisplayName ?? name,
        bungieGlobalDisplayNameCode: overrides.bungieGlobalDisplayNameCode ?? code,
        isPublic,
    };
}

function buildTransitoryData(
    partyMembers: PartyMemberInput[],
    startTime: string,
    activityHash: number,
    activityModeType: number
) {
    return {
        data: {
            partyMembers: partyMembers.map((member) => ({
                membershipId: member.membershipId,
                emblemHash: 0,
                displayName: member.displayName ?? member.membershipId,
                status: member.status ?? 1,
            })),
            currentActivity: {
                startTime,
                endTime: '',
                score: 0,
                highestOpposingFactionScore: 0,
                numberOfOpponents: 0,
                numberOfPlayers: partyMembers.length,
                currentActivityHash: activityHash,
                currentActivityModeHash: 0,
                currentActivityModeType: activityModeType,
                currentPlaylistActivityHash: 0,
            },
            joinability: { openSlots: 0, privacySetting: 0, closedReasons: 0 },
        },
    };
}

/** A public account mid-raid: character activity and transitory data agree. */
export function buildActiveProfile(overrides: ActiveProfileOverrides = {}): DestinyProfileResponse {
    const userInfo = buildUserInfo(overrides, 'TestGuardian', 1234, true);
    const activityHash = overrides.activityHash ?? RAID_HASH;
    const startTime = overrides.startTime ?? defaultStartTime();
    const partyMembers = overrides.partyMembers ?? [
        { membershipId: userInfo.membershipId, displayName: userInfo.displayName },
    ];

    return {
        profile: { data: { userInfo, characterIds: [DEFAULT_CHARACTER_ID] } },
        characterActivities: {
            data: {
                [DEFAULT_CHARACTER_ID]: {
                    currentActivityHash: activityHash,
                    currentActivityModeHash: 0,
                    currentActivityModeType: RAID_MODE_TYPE,
                    dateActivityStarted: startTime,
                },
            },
        },
        profileTransitoryData: buildTransitoryData(partyMembers, startTime, activityHash, RAID_MODE_TYPE),
    };
}

/**
 * A private account: characterActivities is withheld, so the only thing that can
 * hint at an activity is transitory data — and it carries no activity hash.
 */
export function buildPrivateProfile(overrides: PrivateProfileOverrides = {}): DestinyProfileResponse {
    const userInfo = buildUserInfo(overrides, 'PrivateGuardian', 5678, false);
    const startTime = overrides.startTime ?? defaultStartTime();
    const partyMembers = overrides.partyMembers ?? [
        { membershipId: userInfo.membershipId, displayName: userInfo.displayName },
    ];

    return {
        profile: { data: { userInfo, characterIds: [DEFAULT_CHARACTER_ID] } },
        characterActivities: { privacy: 2 },
        profileTransitoryData: overrides.withTransitoryData === false
            ? { data: null }
            : buildTransitoryData(partyMembers, startTime, 0, 0),
    };
}

/** A public account sitting in orbit: no current activity anywhere. */
export function buildInactiveProfile(overrides: ProfileIdentityOverrides = {}): DestinyProfileResponse {
    return {
        profile: {
            data: {
                userInfo: buildUserInfo(overrides, 'InactiveGuardian', 9012, true),
                characterIds: [DEFAULT_CHARACTER_ID],
            },
        },
        characterActivities: { data: {} },
        profileTransitoryData: { data: null },
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
    bungieGlobalDisplayName?: string;
    bungieGlobalDisplayNameCode?: number;
}

/**
 * A GetLinkedProfiles response for a single account, shaped so
 * pickPrimaryLinkedProfile resolves it by exact membershipId match.
 */
export function buildLinkedProfiles(overrides: LinkedProfileOverrides = {}): DestinyLinkedProfilesResponse {
    const membershipId = overrides.membershipId ?? DEFAULT_MEMBERSHIP_ID;
    const membershipType = overrides.membershipType ?? DEFAULT_MEMBERSHIP_TYPE;
    const name = overrides.bungieGlobalDisplayName ?? 'TestGuardian';
    const code = overrides.bungieGlobalDisplayNameCode ?? 1234;

    return {
        profiles: [
            {
                membershipId,
                membershipType,
                displayName: name,
                bungieGlobalDisplayName: name,
                bungieGlobalDisplayNameCode: code,
                isCrossSavePrimary: true,
                applicableMembershipTypes: [membershipType],
                isPublic: true,
            },
        ],
        bnetMembership: { membershipId, bungieGlobalDisplayName: name, bungieGlobalDisplayNameCode: code },
    };
}
