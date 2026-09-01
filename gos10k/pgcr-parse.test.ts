import { describe, expect, it } from 'vitest';
import { parsePgcr, type RawPgcrResponse } from './pgcr-parse';
import golden from './fixtures/pgcr-17121001798.json';

/**
 * Every fixture here is derived from ONE real payload — instance 17121001798,
 * fetched live from Bungie and committed unmodified. Variants are produced by
 * cloning it and mutating the one field under test, never by writing a payload
 * from scratch.
 *
 * That is the whole point of this file. The bug that cost the previous session a
 * full run was a belief about payload shape (Activity History was assumed to
 * carry activityWasStartedFromBeginning; it does not), not a logic error. A
 * fixture invented from imagination would have confirmed the same wrong belief.
 * Mutating a real payload cannot.
 */

const REAL = golden.Response as unknown as RawPgcrResponse;

function clone(): RawPgcrResponse {
    return structuredClone(REAL);
}

describe('parsePgcr — the golden payload', () => {
    const parsed = parsePgcr(REAL);

    it('reads the three run-level fields the backfill exists to recover', () => {
        // These are PGCR-only. gos_10k_runs holds NULL for all three until this
        // parse writes them; anything Activity History could have supplied would
        // have been invented.
        expect(parsed.run.startingPhaseIndex).toBe(0);
        expect(parsed.run.activityWasStartedFromBeginning).toBe(1);
        expect(parsed.run.durationSeconds).toBe(2311);
    });

    it('records run metadata', () => {
        expect(parsed.run.instanceId).toBe('17121001798');
        expect(parsed.run.activityDifficultyTier).toBe(-1);
        expect(parsed.run.isPrivate).toBe(0);
    });

    it('distinguishes entry_count from player_count', () => {
        // Garden of Salvation is a 6-player raid, and this PGCR has 8 entries:
        // two slots were replacements. The gap between these two numbers is the
        // whole reason they are separate columns — collapsing them would erase
        // every mid-run substitution across 10k runs.
        expect(parsed.run.entryCount).toBe(8);
        expect(parsed.run.playerCount).toBe(8);
    });

    it('keeps Name#Code intact for every player', () => {
        // CLAUDE.md: "Player identity is Name#Code." Storing the name without the
        // code was a real bug in this repo once; two guardians can share a global
        // display name, so the code is not decoration.
        const identities = parsed.players.map(
            (p) => `${p.bungieGlobalDisplayName}#${p.bungieGlobalDisplayNameCode}`
        );
        expect(identities).toContain('Nesspo#9781');
        expect(identities).toContain('DarrenJones#7664');
        expect(identities).toHaveLength(8);
    });

    it('keeps displayName separate from bungieGlobalDisplayName', () => {
        // They differ for real players — this entry's platform name is
        // "EmmGryner" while the Bungie name is "DarrenJones". Conflating them
        // would silently rename people.
        const darren = parsed.players.find((p) => p.bungieGlobalDisplayName === 'DarrenJones');
        expect(darren?.displayName).toBe('EmmGryner');
    });

    it('parses one player row in full', () => {
        const nesspo = parsed.players.find((p) => p.bungieGlobalDisplayName === 'Nesspo');
        expect(nesspo).toMatchObject({
            instanceId: '17121001798',
            characterId: '2305843009269927888',
            membershipId: '4611686018437585442',
            membershipType: 1,
            characterClass: 'Warlock',
            classHash: 2271682572,
            raceHash: 898834093,
            genderHash: 3111576190,
            emblemHash: 532530778,
            lightLevel: 539,
            completed: 1,
            completionReason: 0,
            kills: 227,
            deaths: 5,
            assists: 21,
            startSeconds: 0,
            timePlayedSeconds: 2311,
            // extended.values — the ability breakdown
            precisionKills: 10,
            grenadeKills: 4,
            meleeKills: 6,
            superKills: 0,
            abilityKills: 0,
        });
    });

    it('captures a player who did not complete the run', () => {
        // Both non-completers matter: they are people who showed up and left, and
        // filtering them out at parse time would make them unrecoverable without
        // a re-crawl.
        const incomplete = parsed.players.filter((p) => p.completed === 0);
        expect(incomplete.map((p) => p.bungieGlobalDisplayName).sort()).toEqual([
            'Big_Swiff',
            'HIROxNAKAMURAx87',
        ]);
    });

    it('carries fireteamId as an explicitly lossy float', () => {
        // Bungie serializes this as 6.607053075707733E+18 — an IEEE-754 double.
        // The exact int64 is unrecoverable, and displayValue is a garbage
        // -2147483648. Stored only as a weak grouping hint; never an identity.
        const nesspo = parsed.players.find((p) => p.bungieGlobalDisplayName === 'Nesspo');
        expect(nesspo?.fireteamIdApprox).toBe(6607053075707733000);
    });

    it('flattens extended.weapons into one row per weapon per character', () => {
        const nesspoWeapons = parsed.weapons.filter(
            (w) => w.characterId === '2305843009269927888'
        );
        expect(nesspoWeapons).toHaveLength(10);

        const topWeapon = nesspoWeapons.find((w) => w.weaponHash === 613334176);
        expect(topWeapon).toEqual({
            instanceId: '17121001798',
            characterId: '2305843009269927888',
            weaponHash: 613334176,
            kills: 70,
            precisionKills: 0,
        });
    });

    it('does not store the derived precision ratio', () => {
        // uniqueWeaponKillsPrecisionKills is precision/kills. Storing a value
        // that can be computed from two adjacent columns invites them to drift.
        for (const w of parsed.weapons) {
            expect(Object.keys(w).sort()).toEqual([
                'characterId',
                'instanceId',
                'kills',
                'precisionKills',
                'weaponHash',
            ]);
        }
    });
});

describe('parsePgcr — full-clear determination', () => {
    // Mirrors src/lib/crawler/pgcr.ts:39-42 exactly. It is a disjunction, not
    // just the boolean: matching it is what makes this count comparable to the
    // main app's. Writing a tighter rule here would produce a number that looks
    // authoritative and answers a different question.

    it('is a full clear when the flag is true', () => {
        expect(parsePgcr(REAL).run.isFullClear).toBe(true);
    });

    it('is a full clear when startingPhaseIndex is 0 despite a false flag', () => {
        const p = clone();
        p.activityWasStartedFromBeginning = false;
        p.startingPhaseIndex = 0;
        expect(parsePgcr(p).run.isFullClear).toBe(true);
    });

    it('is a full clear when both fields are absent', () => {
        const p = clone();
        delete p.activityWasStartedFromBeginning;
        delete p.startingPhaseIndex;
        const parsed = parsePgcr(p);
        expect(parsed.run.isFullClear).toBe(true);
        // ...but absence must still be stored as NULL, not invented as 0/1.
        expect(parsed.run.startingPhaseIndex).toBeNull();
        expect(parsed.run.activityWasStartedFromBeginning).toBeNull();
    });

    it('is NOT a full clear when joined at a later phase', () => {
        const p = clone();
        p.activityWasStartedFromBeginning = false;
        p.startingPhaseIndex = 3;
        const parsed = parsePgcr(p);
        expect(parsed.run.isFullClear).toBe(false);
        expect(parsed.run.startingPhaseIndex).toBe(3);
        expect(parsed.run.activityWasStartedFromBeginning).toBe(0);
    });
});

describe('parsePgcr — activityDurationSeconds agreement', () => {
    // The assumption under test is "always agrees within a single PGCR". It is
    // instrumented rather than trusted, because the last unverified field
    // semantics in this project (completionReason) did not survive contact with
    // the data.

    it('reports no disagreement when every entry agrees', () => {
        expect(parsePgcr(REAL).run.durationDisagreement).toBe(0);
    });

    it('flags disagreement and takes the maximum', () => {
        const p = clone();
        p.entries[0]!.values.activityDurationSeconds!.basic.value = 1800;
        const parsed = parsePgcr(p);
        expect(parsed.run.durationDisagreement).toBe(1);
        expect(parsed.run.durationSeconds).toBe(2311);
    });

    it('survives a PGCR with no entries at all', () => {
        const p = clone();
        p.entries = [];
        const parsed = parsePgcr(p);
        // NULL, not 0: "Bungie did not report a duration" is not "the raid took
        // no time", and a stored 0 on an 'ok' row could never be told apart.
        expect(parsed.run.durationSeconds).toBeNull();
        expect(parsed.run.durationDisagreement).toBe(0);
        expect(parsed.run.entryCount).toBe(0);
        expect(parsed.run.playerCount).toBe(0);
        expect(parsed.players).toEqual([]);
        expect(parsed.weapons).toEqual([]);
    });
});

describe('parsePgcr — missing optional blocks', () => {
    it('stores NULL, not 0, when extended is absent entirely', () => {
        // "No extended block" and "zero grenade kills" are different facts. A
        // DEFAULT 0 here would make them indistinguishable forever — the same
        // trap that forced the DB to be recreated last session.
        const p = clone();
        delete p.entries[0]!.extended;
        const parsed = parsePgcr(p);
        const player = parsed.players[0]!;
        expect(player.precisionKills).toBeNull();
        expect(player.grenadeKills).toBeNull();
        expect(player.meleeKills).toBeNull();
        expect(player.superKills).toBeNull();
        expect(player.abilityKills).toBeNull();
        // Real stats outside extended are untouched.
        expect(player.kills).toBe(10);
    });

    it('yields no weapon rows for a character with an empty weapons list', () => {
        const p = clone();
        p.entries[0]!.extended!.weapons = [];
        const parsed = parsePgcr(p);
        const first = REAL.entries[0]!.characterId;
        expect(parsed.weapons.filter((w) => w.characterId === first)).toEqual([]);
    });

    it('yields no weapon rows when the weapons key is missing', () => {
        const p = clone();
        delete p.entries[0]!.extended!.weapons;
        const parsed = parsePgcr(p);
        expect(parsed.weapons.filter((w) => w.characterId === REAL.entries[0]!.characterId)).toEqual([]);
    });

    it('tolerates a missing values block on an entry', () => {
        const p = clone();
        // @ts-expect-error deliberately malformed: proving the parse degrades
        // rather than throwing mid-run and stranding 10k rows half-written.
        delete p.entries[0]!.values;
        const parsed = parsePgcr(p);
        expect(parsed.players[0]!.kills).toBe(0);
        expect(parsed.players[0]!.completed).toBeNull();
    });
});

describe('parsePgcr — defensive counting', () => {
    it('counts duplicate character entries instead of silently overwriting', () => {
        // PK is (instance_id, character_id). If Bungie ever returned two entries
        // for one character, the upsert would quietly keep the last. Counting it
        // means the run reports the anomaly rather than hiding it.
        const p = clone();
        p.entries.push(structuredClone(p.entries[0]!));
        const parsed = parsePgcr(p);
        expect(parsed.run.duplicateCharacterEntries).toBe(1);
        expect(parsed.players).toHaveLength(8);
    });

    it('skips an entry with no membership id instead of inventing one', () => {
        // membership_id is NOT NULL, and rightly so — a player row with no
        // identity is not a player. A placeholder would show up in the "who
        // helped him" analysis as a real person who never existed.
        const p = clone();
        delete (p.entries[0]!.player as { destinyUserInfo?: unknown }).destinyUserInfo;
        const parsed = parsePgcr(p);
        expect(parsed.run.malformedEntries).toBe(1);
        expect(parsed.players).toHaveLength(7);
        expect(parsed.run.entryCount).toBe(8);
    });

    it('reports zero malformed entries on the real payload', () => {
        expect(parsePgcr(REAL).run.malformedEntries).toBe(0);
    });

    it('counts distinct memberships, not entries, for playerCount', () => {
        const p = clone();
        const dupe = structuredClone(p.entries[1]!);
        dupe.characterId = '9999999999999999';
        p.entries.push(dupe);
        const parsed = parsePgcr(p);
        expect(parsed.run.entryCount).toBe(9);
        expect(parsed.run.playerCount).toBe(8);
    });
});
