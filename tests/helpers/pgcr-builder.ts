import type {
    DestinyHistoricalStatsValue,
    DestinyPostGameCarnageReportData,
    DestinyPostGameCarnageReportEntry,
} from '../../src/lib/bungie/types';

/**
 * Programmatic PGCR builders.
 *
 * Fixtures for realism, builders for permutation. When a test needs one specific
 * field varied — a duration removed, a single entry's completion flipped — reach
 * for a builder. When a test needs to prove we handle what Bungie actually sends,
 * reach for a fixture in ../fixtures.
 *
 * Defaults describe a clean six-player full clear, so every builder call states
 * only what makes its case interesting.
 */

/** Salvation's Edge. Any hash in manifest.ts's RAID_DEFINITIONS works. */
export const RAID_HASH = 2192826039;

/** Not present in RAID_DEFINITIONS, so isRaidActivityHash rejects it. */
export const NON_RAID_HASH = 1;

function stat(value: number): DestinyHistoricalStatsValue {
    return { basic: { value, displayValue: String(value) } };
}

export interface EntryOptions {
    membershipId?: string;
    membershipType?: number;
    displayName?: string;
    /** Pass `null` to omit the field entirely — the case where Bungie withholds it. */
    bungieGlobalDisplayName?: string | null;
    bungieGlobalDisplayNameCode?: number | null;
    characterClass?: string;
    lightLevel?: number;
    completed?: boolean;
    kills?: number;
    deaths?: number;
    assists?: number;
    timePlayedSeconds?: number;
    /** Per-player join offset. Pass `null` to omit, collapsing Tier 2 to MAX(timePlayed). */
    startSeconds?: number | null;
    /** Activity-level duration. Pass `null` to omit, forcing the Tier 2 fallback. */
    activityDurationSeconds?: number | null;
}

export function buildEntry(options: EntryOptions = {}): DestinyPostGameCarnageReportEntry {
    const {
        membershipId = '4611686018400000001',
        membershipType = 3,
        displayName = 'Guardian',
        bungieGlobalDisplayName = 'Guardian',
        bungieGlobalDisplayNameCode = 1234,
        characterClass = 'Warlock',
        lightLevel = 2010,
        completed = true,
        kills = 100,
        deaths = 2,
        assists = 40,
        timePlayedSeconds = 1800,
        startSeconds = 0,
        activityDurationSeconds = 1800,
    } = options;

    const values: Record<string, DestinyHistoricalStatsValue> = {
        completed: stat(completed ? 1 : 0),
        kills: stat(kills),
        deaths: stat(deaths),
        assists: stat(assists),
        timePlayedSeconds: stat(timePlayedSeconds),
    };

    // Omitted rather than zeroed: the readers distinguish absent from 0, and an
    // absent activityDurationSeconds is what drives the Tier 2 fallback.
    if (startSeconds !== null) {
        values.startSeconds = stat(startSeconds);
    }
    if (activityDurationSeconds !== null) {
        values.activityDurationSeconds = stat(activityDurationSeconds);
    }

    return {
        standing: 0,
        player: {
            destinyUserInfo: {
                membershipId,
                membershipType,
                displayName,
                ...(bungieGlobalDisplayName !== null ? { bungieGlobalDisplayName } : {}),
                ...(bungieGlobalDisplayNameCode !== null ? { bungieGlobalDisplayNameCode } : {}),
            },
            characterClass,
            characterLevel: 50,
            lightLevel,
        },
        values,
    };
}

export interface PGCROptions {
    instanceId?: string;
    activityHash?: number;
    /** Set independently of directorActivityHash to test the referenceId fallback. */
    referenceId?: number;
    /** ISO 8601. Bungie reports UTC. */
    period?: string;
    activityWasStartedFromBeginning?: boolean;
    /**
     * Bungie reports this as 0 on every real PGCR, including checkpoint runs, so it
     * no longer distinguishes anything. Pass `null` to omit it entirely; pass a
     * number only when testing the legacy path.
     */
    startingPhaseIndex?: number | null;
    /** Raw Bungie difficulty tier. Pass `null` to omit entirely (pre-migration rows). */
    activityDifficultyTier?: number | null;
    entries?: DestinyPostGameCarnageReportEntry[];
}

export function buildPGCR(options: PGCROptions = {}): DestinyPostGameCarnageReportData {
    const {
        instanceId = '17091392013',
        activityHash = RAID_HASH,
        referenceId = activityHash,
        period = '2026-07-26T12:00:00Z',
        activityWasStartedFromBeginning = true,
        startingPhaseIndex = null,
        activityDifficultyTier = null,
        entries = buildFireteam(),
    } = options;

    const pgcr = {
        period,
        activityWasStartedFromBeginning,
        activityDetails: {
            referenceId,
            directorActivityHash: activityHash,
            instanceId,
            mode: 4,
            modes: [4],
        },
        entries,
    } as DestinyPostGameCarnageReportData;

    if (startingPhaseIndex !== null) {
        pgcr.startingPhaseIndex = startingPhaseIndex;
    }

    if (activityDifficultyTier !== null) {
        pgcr.activityDifficultyTier = activityDifficultyTier;
    }

    return pgcr;
}

/**
 * Six distinct players. `completions` sets how many finished, counting from the
 * first entry — so `buildFireteam({ completions: 1 })` is the "only one of six
 * completed" case.
 */
export function buildFireteam(
    options: { size?: number; completions?: number; entry?: EntryOptions } = {}
): DestinyPostGameCarnageReportEntry[] {
    const { size = 6, completions = size, entry = {} } = options;

    return Array.from({ length: size }, (_, index) =>
        buildEntry({
            membershipId: `461168601840000000${index + 1}`,
            displayName: `Guardian${index + 1}`,
            bungieGlobalDisplayName: `Guardian${index + 1}`,
            bungieGlobalDisplayNameCode: 1000 + index,
            completed: index < completions,
            ...entry,
        })
    );
}
