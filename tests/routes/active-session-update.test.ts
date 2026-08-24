import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resetTestDb, testDb } from '../helpers/db';
import { buildWriteRequest } from '../helpers/build-write-request';
import {
    buildActiveProfile,
    buildPrivateProfile,
    buildInactiveProfile,
} from '../helpers/bungie-profile-builder';

const SECRET = 'test-secret-not-a-real-credential';
const T0 = new Date('2026-08-03T12:00:00Z').getTime();

// Salvation's Edge hash — must match the builder's default so parseAndStoreActivity
// recognises it as a raid.
const RAID_HASH = 2192826039;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.stubEnv('PAGE_TOKEN_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://destinyfarmfinder.qzz.io');
    resetTestDb();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

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

describe('POST /api/players/active-session-update', () => {
    // ---- Auth / validation ----

    it('returns 403 when the request is not trusted', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const request = buildWriteRequest('/api/players/active-session-update', validBody(), {
            origin: 'https://evil.example.com',
        });
        const response = await POST(request);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Forbidden' });
    });

    it('returns 400 for invalid JSON', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const request = new (await import('next/server')).NextRequest(
            'http://localhost:3100/api/players/active-session-update',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    host: 'localhost:3100',
                    origin: 'http://localhost:3100',
                    'x-forwarded-for': '1.2.3.4',
                    'x-page-token': (await import('@/lib/http/request-auth')).mintPageToken(),
                },
                body: '{not json',
            }
        );
        const response = await POST(request);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    });

    it('returns 400 for an invalid membershipId', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const body = { ...validBody(), membershipId: 'abc' };
        const request = buildWriteRequest('/api/players/active-session-update', body);
        const response = await POST(request);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid membershipId' });
    });

    it('returns 400 for an invalid membershipType', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const body = { ...validBody(), membershipType: 42 };
        const request = buildWriteRequest('/api/players/active-session-update', body);
        const response = await POST(request);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid membershipType' });
    });

    it('returns 400 when profileResponse is missing', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const body = { membershipId: '4611686018488400001', membershipType: 3 };
        const request = buildWriteRequest('/api/players/active-session-update', body);
        const response = await POST(request);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Missing profileResponse' });
    });

    // ---- Cooldown ----

    it('returns skipped with reason recently_updated on cooldown', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const id = '4611686018488400002';
        const ip = '10.0.0.10';
        const body = validBody(id, buildActiveProfile({ membershipId: id }));

        await POST(buildWriteRequest('/api/players/active-session-update', body, { ip }));

        const response = await POST(
            buildWriteRequest('/api/players/active-session-update', body, { ip })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ skipped: true, reason: 'recently_updated' });
    });

    // ---- Active session happy path ----

    it('returns updated: true with an enriched active session', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const id = '4611686018488400003';
        const ip = '10.0.0.11';
        const startTime = new Date(T0 - 20 * 60_000).toISOString();

        const profile = buildActiveProfile({
            membershipId: id,
            bungieGlobalDisplayName: 'ActiveHero',
            bungieGlobalDisplayNameCode: 4321,
            dateActivityStarted: startTime,
            activityHash: RAID_HASH,
            partyMembers: [
                { membershipId: id, displayName: 'ActiveHero', status: 1 },
            ],
        });

        const body = { membershipId: id, membershipType: 3, profileResponse: profile };
        const response = await POST(
            buildWriteRequest('/api/players/active-session-update', body, { ip })
        );
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
        const { POST } = await import('@/app/api/players/active-session-update/route');
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
        const response = await POST(
            buildWriteRequest('/api/players/active-session-update', body, { ip })
        );
        const json = await response.json();
        expect(json.updated).toBe(true);
        // The unknown teammate has no membershipType in the enriched party (not in players table),
        // so it appears in unresolvedMemberIds.
        expect(json.unresolvedMemberIds).toContain(unknownTeammateId);
    });

    // ---- Inactive + public → session deleted ----

    it('clears the session for an inactive public player', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const id = '4611686018488400005';
        const ip = '10.0.0.13';

        // First, create an active session
        const activeBody = validBody(id, buildActiveProfile({ membershipId: id }));
        await POST(buildWriteRequest('/api/players/active-session-update', activeBody, { ip }));

        // Advance time past the 30s cooldown
        vi.setSystemTime(T0 + 31_000);

        // Now send an inactive profile (public)
        const inactiveProfile = buildInactiveProfile({ membershipId: id });
        const body = { membershipId: id, membershipType: 3, profileResponse: inactiveProfile };
        const response = await POST(
            buildWriteRequest('/api/players/active-session-update', body, { ip })
        );
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
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const selfId = '4611686018488400006';
        const teammateId = '4611686018488400007';
        const ip = '10.0.0.14';

        // Seed a stored session from the teammate that includes selfId in party_members_json
        const db = testDb();
        db.prepare(`
            INSERT INTO active_sessions
            (membership_id, membership_type, display_name, activity_hash, raid_key,
             started_at, party_members_json, player_count, checked_at)
            VALUES (?, 3, 'Teammate', ?, 'salvations_edge', ?, ?, 2, unixepoch())
        `).run(
            teammateId,
            RAID_HASH,
            new Date(T0 - 10 * 60_000).toISOString(),
            JSON.stringify([
                { membershipId: teammateId, displayName: 'Teammate', status: 1 },
                { membershipId: selfId, displayName: selfId, status: 1 },
            ])
        );

        const privateProfile = buildPrivateProfile({
            membershipId: selfId,
            bungieGlobalDisplayName: 'PrivateOne',
            bungieGlobalDisplayNameCode: 2222,
            withTransitoryData: false,
        });

        const body = { membershipId: selfId, membershipType: 3, profileResponse: privateProfile };
        const response = await POST(
            buildWriteRequest('/api/players/active-session-update', body, { ip })
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.updated).toBe(false);
        expect(json.privacyRestricted).toBe(true);
        expect(json.activeSession).toBeTruthy();
        expect(json.activeSession.activityHash).toBe(RAID_HASH);
    });

    // ---- Inactive + private + provisional session (transitory data with candidateMembers) ----

    it('returns a provisional session for a private player with transitory activity data', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const selfId = '4611686018488400008';
        const teammateId = '4611686018488400009';
        const ip = '10.0.0.15';
        const startTime = new Date(T0 - 15 * 60_000).toISOString();

        // Seed the teammate in the players table so they get a membershipType
        const db = testDb();
        db.prepare(`
            INSERT INTO players (membership_id, membership_type, display_name,
                                 bungie_global_display_name, bungie_global_display_name_code)
            VALUES (?, 3, 'TeammateName', 'TeammateName', 3333)
        `).run(teammateId);

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
        const response = await POST(
            buildWriteRequest('/api/players/active-session-update', body, { ip })
        );
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
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const id = '4611686018488400010';
        const ip = '10.0.0.16';

        const privateProfile = buildPrivateProfile({
            membershipId: id,
            bungieGlobalDisplayName: 'PrivateThree',
            bungieGlobalDisplayNameCode: 5555,
            withTransitoryData: false,
        });

        const body = { membershipId: id, membershipType: 3, profileResponse: privateProfile };
        const response = await POST(
            buildWriteRequest('/api/players/active-session-update', body, { ip })
        );
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.updated).toBe(false);
        expect(json.privacyRestricted).toBe(true);
        expect(json.activeSession).toBeNull();
        expect(json.provisionalSession).toBeUndefined();
    });

    // ---- Maintenance 503 ----

    it('returns 503 when the database is in maintenance', async () => {
        const { POST } = await import('@/app/api/players/active-session-update/route');
        const id = '4611686018488400011';
        const ip = '10.0.0.17';

        // Pragmatic ADR 0004 exception: fault injection on the DB function to
        // test the maintenance error path without actually triggering quiesce.
        const queries = await import('@/lib/db/queries');
        const { DatabaseMaintenanceError } = await import('@/lib/db');
        vi.spyOn(queries, 'getPlayerIdentity').mockImplementation(() => {
            throw new DatabaseMaintenanceError();
        });

        const body = validBody(id, buildActiveProfile({ membershipId: id }));
        const response = await POST(
            buildWriteRequest('/api/players/active-session-update', body, { ip })
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ skipped: true, reason: 'maintenance' });

        vi.restoreAllMocks();
    });
});
