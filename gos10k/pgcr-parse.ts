/**
 * Pure transform: one raw PGCR `Response` in, the rows for three tables out.
 *
 * Deliberately free of I/O — no fetch, no database, no clock. That is what makes
 * it the seam the tests attach to, and it is also the reason the raw payloads are
 * archived gzipped in gos_10k_pgcr_raw: the whole players/weapons table can be
 * re-derived from local data by replaying the archive through this function, with
 * no second pass against Bungie. The 10k-request crawl happens exactly once; the
 * parse can be corrected forever.
 */

// ---------------------------------------------------------------------------
// Raw payload shape
// ---------------------------------------------------------------------------
// Only the fields actually read are declared. Everything optional is genuinely
// optional in the wild — see the tests for the cases that forced each `?`.

interface BasicStat {
    basic: { value: number; displayValue?: string };
}

interface RawWeapon {
    referenceId: number;
    values?: {
        uniqueWeaponKills?: BasicStat;
        uniqueWeaponPrecisionKills?: BasicStat;
    };
}

interface RawEntry {
    characterId: string;
    player: {
        destinyUserInfo: {
            membershipId: string;
            membershipType: number;
            displayName?: string;
            bungieGlobalDisplayName?: string;
            bungieGlobalDisplayNameCode?: number;
        };
        characterClass?: string;
        classHash?: number;
        raceHash?: number;
        genderHash?: number;
        emblemHash?: number;
        lightLevel?: number;
    };
    values: {
        completed?: BasicStat;
        completionReason?: BasicStat;
        kills?: BasicStat;
        deaths?: BasicStat;
        assists?: BasicStat;
        startSeconds?: BasicStat;
        timePlayedSeconds?: BasicStat;
        activityDurationSeconds?: BasicStat;
        fireteamId?: BasicStat;
    };
    extended?: {
        weapons?: RawWeapon[];
        values?: {
            precisionKills?: BasicStat;
            weaponKillsGrenade?: BasicStat;
            weaponKillsMelee?: BasicStat;
            weaponKillsSuper?: BasicStat;
            weaponKillsAbility?: BasicStat;
        };
    };
}

export interface RawPgcrResponse {
    period?: string;
    startingPhaseIndex?: number | null;
    activityWasStartedFromBeginning?: boolean | null;
    activityDifficultyTier?: number;
    activityDetails: {
        instanceId: string;
        referenceId?: number;
        directorActivityHash?: number;
        isPrivate?: boolean;
    };
    entries: RawEntry[];
}

// ---------------------------------------------------------------------------
// Parsed output
// ---------------------------------------------------------------------------

export interface ParsedRun {
    instanceId: string;
    activityHash: number | null;
    startingPhaseIndex: number | null;
    activityWasStartedFromBeginning: number | null;
    isFullClear: boolean;
    durationSeconds: number;
    /** 1 when entries reported more than one activityDurationSeconds. */
    durationDisagreement: number;
    activityDifficultyTier: number | null;
    isPrivate: number | null;
    /** Rows in entries[] — 8 for a 6-player raid means two replacements. */
    entryCount: number;
    /** Distinct memberships. Deliberately not entryCount. */
    playerCount: number;
    /** Anomaly counter, logged by the caller. Expected to be 0 everywhere. */
    duplicateCharacterEntries: number;
}

export interface ParsedPlayer {
    instanceId: string;
    characterId: string;
    membershipId: string;
    membershipType: number;
    displayName: string | null;
    bungieGlobalDisplayName: string | null;
    bungieGlobalDisplayNameCode: number | null;
    characterClass: string | null;
    classHash: number | null;
    raceHash: number | null;
    genderHash: number | null;
    emblemHash: number | null;
    lightLevel: number | null;
    completed: number | null;
    completionReason: number | null;
    kills: number;
    deaths: number;
    assists: number;
    startSeconds: number;
    timePlayedSeconds: number;
    precisionKills: number | null;
    grenadeKills: number | null;
    meleeKills: number | null;
    superKills: number | null;
    abilityKills: number | null;
    fireteamIdApprox: number | null;
}

export interface ParsedWeapon {
    instanceId: string;
    characterId: string;
    weaponHash: number;
    kills: number;
    precisionKills: number;
}

export interface ParsedPgcr {
    run: ParsedRun;
    players: ParsedPlayer[];
    weapons: ParsedWeapon[];
}

// ---------------------------------------------------------------------------

/** Bungie wraps every stat as { basic: { value, displayValue } }. */
function stat(s: BasicStat | undefined): number | null {
    const v = s?.basic?.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** For counters where absence genuinely means zero (kills, deaths, assists). */
function statOrZero(s: BasicStat | undefined): number {
    return stat(s) ?? 0;
}

function boolToInt(b: boolean | null | undefined): number | null {
    return typeof b === 'boolean' ? (b ? 1 : 0) : null;
}

export function parsePgcr(response: RawPgcrResponse): ParsedPgcr {
    const instanceId = response.activityDetails.instanceId;
    const entries = Array.isArray(response.entries) ? response.entries : [];

    const startingPhaseIndex =
        typeof response.startingPhaseIndex === 'number' ? response.startingPhaseIndex : null;
    const startedFromBeginning = boolToInt(response.activityWasStartedFromBeginning);

    // Copied verbatim from src/lib/crawler/pgcr.ts:39-42 rather than reinvented.
    // It is a disjunction: an absent startingPhaseIndex counts as a full clear.
    // Any tighter rule here would produce a number that cannot be compared to
    // the main app's.
    const isFullClear =
        response.activityWasStartedFromBeginning === true ||
        response.startingPhaseIndex === 0 ||
        response.startingPhaseIndex === undefined ||
        response.startingPhaseIndex === null;

    // activityDurationSeconds is repeated once per entry and is *expected* to
    // agree. Expected, not trusted — take the max, and flag any disagreement so
    // the run reports how often the assumption held instead of asserting it.
    const durations = entries
        .map((e) => stat(e.values?.activityDurationSeconds))
        .filter((d): d is number => d !== null);
    const durationSeconds = durations.length > 0 ? Math.max(...durations) : 0;
    const durationDisagreement = new Set(durations).size > 1 ? 1 : 0;

    const players: ParsedPlayer[] = [];
    const weapons: ParsedWeapon[] = [];
    const seenCharacterIds = new Set<string>();
    let duplicateCharacterEntries = 0;

    for (const entry of entries) {
        const characterId = entry.characterId;
        if (seenCharacterIds.has(characterId)) {
            // (instance_id, character_id) is the primary key, so a second entry
            // for one character would be silently swallowed by the upsert.
            // Count it; the caller logs it.
            duplicateCharacterEntries++;
            continue;
        }
        seenCharacterIds.add(characterId);

        const user = entry.player?.destinyUserInfo;
        const values = entry.values ?? {};
        const ext = entry.extended;
        const extValues = ext?.values;

        players.push({
            instanceId,
            characterId,
            membershipId: user?.membershipId,
            membershipType: user?.membershipType,
            displayName: user?.displayName ?? null,
            bungieGlobalDisplayName: user?.bungieGlobalDisplayName ?? null,
            // Name#Code. Without the code these rows cannot render an identity,
            // and two guardians can share a global display name.
            bungieGlobalDisplayNameCode: user?.bungieGlobalDisplayNameCode ?? null,
            characterClass: entry.player?.characterClass ?? null,
            // The hash is stable; characterClass is a localized string.
            classHash: entry.player?.classHash ?? null,
            raceHash: entry.player?.raceHash ?? null,
            genderHash: entry.player?.genderHash ?? null,
            emblemHash: entry.player?.emblemHash ?? null,
            lightLevel: entry.player?.lightLevel ?? null,
            completed: stat(values.completed),
            completionReason: stat(values.completionReason),
            kills: statOrZero(values.kills),
            deaths: statOrZero(values.deaths),
            assists: statOrZero(values.assists),
            startSeconds: statOrZero(values.startSeconds),
            timePlayedSeconds: statOrZero(values.timePlayedSeconds),
            // NULL rather than 0 when the extended block is absent: "not
            // reported" and "zero" are different facts, and a default would
            // fuse them permanently.
            precisionKills: extValues ? statOrZero(extValues.precisionKills) : null,
            grenadeKills: extValues ? statOrZero(extValues.weaponKillsGrenade) : null,
            meleeKills: extValues ? statOrZero(extValues.weaponKillsMelee) : null,
            superKills: extValues ? statOrZero(extValues.weaponKillsSuper) : null,
            abilityKills: extValues ? statOrZero(extValues.weaponKillsAbility) : null,
            // LOSSY BY CONSTRUCTION. Bungie serializes fireteamId as a JSON
            // number (6.607053075707733E+18), so the exact int64 is already gone
            // before it reaches us, and displayValue is a garbage -2147483648.
            // Usable as a weak "did these people queue together" hint; never as
            // an identity or a join key.
            fireteamIdApprox: stat(values.fireteamId),
        });

        for (const weapon of ext?.weapons ?? []) {
            weapons.push({
                instanceId,
                characterId,
                weaponHash: weapon.referenceId,
                kills: statOrZero(weapon.values?.uniqueWeaponKills),
                precisionKills: statOrZero(weapon.values?.uniqueWeaponPrecisionKills),
                // uniqueWeaponKillsPrecisionKills is deliberately dropped: it is
                // precisionKills / kills, and a stored derivation can drift from
                // the columns it derives from.
            });
        }
    }

    return {
        run: {
            instanceId,
            // Same fallback the rest of the repo uses (src/lib/crawler/pgcr.ts:28).
            activityHash:
                response.activityDetails.directorActivityHash ??
                response.activityDetails.referenceId ??
                null,
            startingPhaseIndex,
            activityWasStartedFromBeginning: startedFromBeginning,
            isFullClear,
            durationSeconds,
            durationDisagreement,
            activityDifficultyTier:
                typeof response.activityDifficultyTier === 'number'
                    ? response.activityDifficultyTier
                    : null,
            isPrivate: boolToInt(response.activityDetails.isPrivate),
            entryCount: entries.length,
            playerCount: new Set(entries.map((e) => e.player?.destinyUserInfo?.membershipId)).size,
            duplicateCharacterEntries,
        },
        players,
        weapons,
    };
}
