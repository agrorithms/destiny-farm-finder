import { describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/players/active-session-update/route';
import { upsertActiveSession } from '@/lib/db/queries';
import { buildWriteRequest } from '../helpers/build-write-request';
import { withDbQuiesced } from '../helpers/db-quiesce';
import { testDb } from '../helpers/db';
import { seedPlayer } from '../helpers/seed';
import {
    RAID_HASH,
    buildActiveProfile,
    buildPrivateProfile,
    buildInactiveProfile,
} from '../helpers/bungie-profile-builder';
import { T0, installWriteRouteEnv } from './write-route-setup';

installWriteRouteEnv();

function validBody(
    membershipId = '4611686018488400001',
    profileResponse = buildActiveProfile({ membershipId })
) {
    return {
        membershipId,
        membershipType: 3,
        profileResponse,
    };
}

function post(body: Record<string, unknown> | string, options?: { origin?: string; ip?: string }) {
    return POST(buildWriteRequest('/api/players/active-session-update', body, options));
}

describe('POST /api/players/active-session-update', () => {
    // ---- Auth / validation ----

    it('returns 403 when the request is not trusted', async () => {
        const response = await post(validBody(), {
            origin: 'https://evil.example.com',
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
    });

    it('returns 400 for invalid JSON', async () => {
        const response = await post('{not json');
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    });

    it('returns 400 for an invalid membershipId', async () => {
        const body = { ...validBody(), membershipId: 'abc' };
        const response = await post(body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid membershipId' });
    });

    it('returns 400 for an invalid membershipType', async () => {
        const body = { ...validBody(), membershipType: 42 };
        const response = await post(body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid membershipType' });
    });

    it('returns 400 when profileResponse is missing', async () => {
        const body = { membershipId: '4611686018488400001', membershipType: 3 };
        const response = await post(body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Missing profileResponse' });
    });

    // ---- Cooldown ----

    it('returns skipped with reason recently_updated on cooldown', async () => {
        const id = '4611686018488400002';
        const ip = '10.0.0.10';
        const body = validBody(id, buildActiveProfile({ membershipId: id }));

        await post(body, { ip });

        const response = await post(body, { ip });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ skipped: true, reason: 'recently_updated' });
    });

    // ---- Active session happy path ----

    it('returns updated: true with an enriched active session', async () => {
        const id = '4611686018488400003';
        const ip = '10.0.0.11';
        const startTime = new Date(T0 - 20 * 60_000).toISOString();

        const profile = buildActiveProfile({
            membershipId: id,
            bungieGlobalDisplayName: 'ActiveHero',
            bungieGlobalDisplayNameCode: 4321,
            startTime,
            activityHash: RAID_HASH,
            partyMembers: [
                { membershipId: id, displayName: 'ActiveHero', status: 1 },
            ],
        });

        const body = { membershipId: id, membershipType: 3, profileResponse: profile };
        const response = await post(body, { ip });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.updated).toBe(true);
        expect(json.activeSession).toBeTruthy();
        expect(json.activeSession.activityHash).toBe(RAID_HASH);
        expect(json.activeSession.membershipId).toBe(id);
        expect(json.player.displayName).toBe('ActiveHero#4321');
        expect(json.unresolvedMemberIds).toEqual([]);
    });

    // ---- unresolvedMemberIds: fireteam member not in the players table ----

    it('includes unresolved member IDs for fireteam members not in the players table', async () => {
        const selfId = '4611686018488400004';
        const unknownTeammateId = '4611686018488400099';
        const ip = '10.0.0.12';

        const profile = buildActiveProfile({
            membershipId: selfId,
            bungieGlobalDisplayName: 'SelfPlayer',
            bungieGlobalDisplayNameCode: 1111,
            partyMembers: [
                { membershipId: selfId, displayName: 'SelfPlayer', status: 1 },
                { membershipId: unknownTeammateId, displayName: unknownTeammateId, status: 1 },
            ],
        });

        const body = { membershipId: selfId, membershipType: 3, profileResponse: profile };
        const response = await post(body, { ip });
        const json = await response.json();
        expect(json.updated).toBe(true);
        // The unknown teammate has no membershipType in the enriched party (not in players table),
        // so it appears in unresolvedMemberIds.
        expect(json.unresolvedMemberIds).toContain(unknownTeammateId);
    });

    // ---- Inactive + public → session deleted ----

    it('clears the session for an inactive public player', async () => {
        const id = '4611686018488400005';
        const ip = '10.0.0.13';

        // First, create an active session
        const activeBody = validBody(id, buildActiveProfile({ membershipId: id }));
        await post(activeBody, { ip });

        // Advance time past the 30s cooldown
        vi.setSystemTime(T0 + 31_000);

        // Now send an inactive profile (public)
        const inactiveProfile = buildInactiveProfile({ membershipId: id });
        const body = { membershipId: id, membershipType: 3, profileResponse: inactiveProfile };
        const response = await post(body, { ip });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.updated).toBe(true);
        expect(json.activeSession).toBeNull();

        // Verify it was actually deleted from the DB
        const db = testDb();
        const row = db.prepare('SELECT * FROM active_sessions WHERE membership_id = ?').get(id);
        expect(row).toBeUndefined();
    });

    // ---- Inactive + private + containing session found ----

    it('returns a containing session for a private player whose teammate has a stored session', async () => {
        const selfId = '4611686018488400006';
        const teammateId = '4611686018488400007';
        const ip = '10.0.0.14';

        // Seed a stored session from the teammate that includes selfId in
        // party_members_json. Through upsertActiveSession — the writer every
        // production path uses — so the row carries the mode columns a raw
        // INSERT would leave null.
        upsertActiveSession({
            membershipId: teammateId,
            membershipType: 3,
            displayName: 'Teammate',
            activityHash: RAID_HASH,
            activityModeType: 4,
            raidKey: 'salvations_edge',
            startedAt: new Date(T0 - 10 * 60_000).toISOString(),
            partyMembersJson: JSON.stringify([
                { membershipId: teammateId, displayName: 'Teammate', status: 1 },
                { membershipId: selfId, displayName: selfId, status: 1 },
            ]),
            playerCount: 2,
        });

        const privateProfile = buildPrivateProfile({
            membershipId: selfId,
            bungieGlobalDisplayName: 'PrivateOne',
            bungieGlobalDisplayNameCode: 2222,
            withTransitoryData: false,
        });

        const body = { membershipId: selfId, membershipType: 3, profileResponse: privateProfile };
        const response = await post(body, { ip });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.updated).toBe(false);
        expect(json.privacyRestricted).toBe(true);
        expect(json.activeSession).toBeTruthy();
        expect(json.activeSession.activityHash).toBe(RAID_HASH);
    });

    // ---- Inactive + private + provisional session (transitory data with candidateMembers) ----

    it('returns a provisional session for a private player with transitory activity data', async () => {
        const selfId = '4611686018488400008';
        const teammateId = '4611686018488400009';
        const ip = '10.0.0.15';
        const startTime = new Date(T0 - 15 * 60_000).toISOString();

        // Seed the teammate in the players table so they get a membershipType
        seedPlayer(teammateId, 'TeammateName', 3333);

        const privateProfile = buildPrivateProfile({
            membershipId: selfId,
            bungieGlobalDisplayName: 'PrivateTwo',
            bungieGlobalDisplayNameCode: 4444,
            startTime,
            partyMembers: [
                { membershipId: selfId, displayName: 'PrivateTwo', status: 1 },
                { membershipId: teammateId, displayName: 'TeammateName', status: 1 },
            ],
        });

        const body = { membershipId: selfId, membershipType: 3, profileResponse: privateProfile };
        const response = await post(body, { ip });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.updated).toBe(false);
        expect(json.privacyRestricted).toBe(true);
        expect(json.activeSession).toBeNull();
        expect(json.provisionalSession).toBeTruthy();
        expect(json.provisionalSession.raidName).toBe('Activity in progress (details private)');
        expect(json.provisionalSession.startedAt).toBe(startTime);
        // The teammate is in the players table with membershipType, so appears in candidateMembers
        expect(json.candidateMembers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ membershipId: teammateId, membershipType: 3 }),
            ])
        );
    });

    // ---- Inactive + private + nothing ----

    it('returns null session for a private player with no activity data', async () => {
        const id = '4611686018488400010';
        const ip = '10.0.0.16';

        const privateProfile = buildPrivateProfile({
            membershipId: id,
            bungieGlobalDisplayName: 'PrivateThree',
            bungieGlobalDisplayNameCode: 5555,
            withTransitoryData: false,
        });

        const body = { membershipId: id, membershipType: 3, profileResponse: privateProfile };
        const response = await post(body, { ip });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.updated).toBe(false);
        expect(json.privacyRestricted).toBe(true);
        expect(json.activeSession).toBeNull();
        expect(json.provisionalSession).toBeUndefined();
    });

    // ---- Maintenance 503 ----

    it('returns 503 when the database is in maintenance', async () => {
        const id = '4611686018488400011';
        const ip = '10.0.0.17';

        const body = validBody(id, buildActiveProfile({ membershipId: id }));
        const response = await withDbQuiesced(() => post(body, { ip }));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ skipped: true, reason: 'maintenance' });
    });
});
