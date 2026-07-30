import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { BungieEndpoints } from '../src/lib/bungie/endpoints';
import { isRaidActivityHash } from '../src/lib/bungie/manifest';
import { readActivityDurationSeconds } from '../src/lib/bungie/pgcr-stats';
import type { DestinyPostGameCarnageReportData } from '../src/lib/bungie/types';

/**
 * Captures real PGCR JSON from Bungie into tests/fixtures/.
 *
 * Fixtures are captured rather than hand-authored so they encode Bungie's actual
 * quirks — absent fields, entry counts above six, durations that disagree with
 * per-player time. A synthetic PGCR only encodes our beliefs about the API, which
 * is exactly what the fixtures exist to check.
 *
 * PGCR data is public; the captured files are committed as-is.
 *
 * The instance IDs below were selected by querying the local database for runs
 * exhibiting each property, so every case is a real observed run rather than a
 * hypothetical. Run with: npm run capture-fixtures
 */

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures');

interface Target {
    file: string;
    instanceId: string;
    why: string;
}

const TARGETS: Target[] = [
    {
        file: 'pgcr-fullclear-salvations-edge.json',
        instanceId: '17091392013',
        why: 'Baseline happy path: six players, started from the beginning, completed.',
    },
    {
        file: 'pgcr-checkpoint-root-of-nightmares.json',
        instanceId: '17091462346',
        why: 'Checkpoint run — activityWasStartedFromBeginning is false. Must be excluded from full-clear leaderboards.',
    },
    {
        file: 'pgcr-zero-completions-vault-of-glass.json',
        instanceId: '17091467640',
        why: 'No entry has completed = 1. The dominant shape in the table (55% of stored PGCRs).',
    },
    {
        file: 'pgcr-partial-completion-last-wish.json',
        instanceId: '17091283535',
        why: 'Some entries completed, some did not. `completed` is per-entry; ANY completion counts.',
    },
    {
        file: 'pgcr-multi-character-garden.json',
        instanceId: '17091200569',
        why: 'Six entries but only two distinct players — three characters each. Also a mild Tier 1 vs Tier 2 duration gap (2069s vs 2037s).',
    },
    {
        file: 'pgcr-absurd-duration-crotas-end.json',
        instanceId: '17091316490',
        why: 'Reports a 27384s (7.6h) activity duration for a run where nobody played past 1093s. The megalobby corruption that FUTURE_ENDED_SKEW_SECONDS exists to reject.',
    },
    {
        file: 'pgcr-missing-bungie-name.json',
        instanceId: '16975643976',
        why: 'At least one entry lacks bungieGlobalDisplayName. Player extraction must tolerate it.',
    },
];

// Instance IDs are broadly sequential, so a raid's neighbours are almost always
// other activity types. We probe forward from a known raid until isRaidActivityHash
// rejects one, giving a genuine non-raid PGCR without needing a curated id.
// Safely within Number.MAX_SAFE_INTEGER (~9e15), so plain arithmetic is fine here.
const NON_RAID_PROBE_START = 17091392014;
const NON_RAID_PROBE_ATTEMPTS = 12;
const NON_RAID_FILE = 'pgcr-non-raid.json';

function requireApiKey(): string {
    const key = process.env.BUNGIE_API_KEY;
    if (!key) {
        console.error('[ERROR] BUNGIE_API_KEY is not set. Add it to .env and re-run.');
        process.exit(1);
    }
    return key;
}

async function fetchPGCR(
    instanceId: string,
    apiKey: string
): Promise<DestinyPostGameCarnageReportData | null> {
    const response = await fetch(BungieEndpoints.getPGCR(instanceId), {
        headers: { 'X-API-Key': apiKey },
        signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
        console.error(`  [ERROR] HTTP ${response.status} for instance ${instanceId}`);
        return null;
    }

    const body = await response.json();
    if (body.ErrorCode !== 1) {
        console.error(`  [ERROR] Bungie ErrorCode ${body.ErrorCode} (${body.ErrorStatus}) for ${instanceId}`);
        return null;
    }

    return body.Response as DestinyPostGameCarnageReportData;
}

/** Reports the fields each fixture is supposed to demonstrate, so a capture that
 *  silently fails to exhibit its property is visible rather than assumed. */
function describe(pgcr: DestinyPostGameCarnageReportData): string {
    const hash = pgcr.activityDetails.directorActivityHash || pgcr.activityDetails.referenceId;
    const entries = pgcr.entries || [];
    const completedCount = entries.filter((e) => e.values?.completed?.basic?.value === 1).length;
    const maxTimePlayed = entries.reduce(
        (max, e) => Math.max(max, e.values?.timePlayedSeconds?.basic?.value || 0),
        0
    );
    // Uses the production reader so the reported value is the one the writer
    // would actually see, not a second interpretation of the same JSON.
    const duration = readActivityDurationSeconds(entries);
    const missingNames = entries.filter((e) => !e.player?.destinyUserInfo?.bungieGlobalDisplayName).length;

    return [
        `raid=${isRaidActivityHash(hash) ? 'yes' : 'NO '}`,
        `hash=${hash}`,
        `entries=${entries.length}`,
        `completed=${completedCount}`,
        `fromBeginning=${pgcr.activityWasStartedFromBeginning}`,
        `startingPhaseIndex=${pgcr.startingPhaseIndex}`,
        `durationSec=${duration ?? 'ABSENT'}`.padEnd(20),
        `maxTimePlayed=${maxTimePlayed}`,
        `missingNames=${missingNames}`,
    ].join('  ');
}

async function capture(target: Target, apiKey: string): Promise<boolean> {
    console.log(`\n${target.file}  (instance ${target.instanceId})`);
    const pgcr = await fetchPGCR(target.instanceId, apiKey);
    if (!pgcr) return false;

    fs.writeFileSync(path.join(FIXTURE_DIR, target.file), JSON.stringify(pgcr, null, 2));
    console.log(`  ${describe(pgcr)}`);
    return true;
}

async function captureNonRaid(apiKey: string): Promise<boolean> {
    console.log(`\n${NON_RAID_FILE}  (probing forward from ${NON_RAID_PROBE_START})`);

    for (let i = 0; i < NON_RAID_PROBE_ATTEMPTS; i++) {
        const instanceId = String(NON_RAID_PROBE_START + i);
        const pgcr = await fetchPGCR(instanceId, apiKey);
        if (!pgcr) continue;

        const hash = pgcr.activityDetails.directorActivityHash || pgcr.activityDetails.referenceId;
        if (isRaidActivityHash(hash)) {
            console.log(`  ${instanceId} is a raid — probing next`);
            continue;
        }

        fs.writeFileSync(path.join(FIXTURE_DIR, NON_RAID_FILE), JSON.stringify(pgcr, null, 2));
        console.log(`  captured instance ${instanceId}`);
        console.log(`  ${describe(pgcr)}`);
        return true;
    }

    console.error(`  [ERROR] No non-raid activity found in ${NON_RAID_PROBE_ATTEMPTS} attempts.`);
    return false;
}

async function main() {
    const apiKey = requireApiKey();
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });

    console.log('Capturing PGCR fixtures from Bungie into tests/fixtures/');
    console.log('Check the reported fields below against each fixture\'s stated purpose.');

    let ok = 0;
    for (const target of TARGETS) {
        if (await capture(target, apiKey)) ok++;
    }
    if (await captureNonRaid(apiKey)) ok++;

    const total = TARGETS.length + 1;
    console.log(`\n${ok}/${total} fixtures captured.`);
    if (ok < total) {
        console.log('Some captures failed — the missing cases will need a synthetic fixture instead.');
        process.exit(1);
    }
}

main();
