import 'dotenv/config';
import { getDb } from '../src/lib/db';
import { getAllRaidDefinitions } from '../src/lib/bungie/manifest';
import { closeDb } from '../src/lib/db';

function main() {
  const db = getDb();
  const raids = getAllRaidDefinitions();

  console.log('========================================');
  console.log('  Debug: Player & PGCR Analysis');
  console.log('========================================\n');

  // 1. Show all players and their crawl status
  const players = db.prepare(`
    SELECT 
      membership_id,
      display_name,
      bungie_global_display_name,
      last_crawled_at,
      discovered_at,
      priority
    FROM players
    ORDER BY last_crawled_at DESC
    LIMIT 20
  `).all() as any[];

  console.log(`Total players in DB: ${(db.prepare('SELECT COUNT(*) as c FROM players').get() as any).c}`);
  console.log('\nRecently crawled players:');
  for (const p of players) {
    const crawledAt = p.last_crawled_at ? new Date(p.last_crawled_at * 1000).toISOString() : 'never';
    console.log(`  ${p.bungie_global_display_name || p.display_name || p.membership_id} — last crawled: ${crawledAt}`);
  }

  // 2. Show all PGCRs and their properties
  const pgcrs = db.prepare(`
    SELECT 
      instance_id,
      activity_hash,
      raid_key,
      period,
      starting_phase_index,
      activity_was_started_from_beginning,
      completed,
      player_count
    FROM pgcrs
    ORDER BY period DESC
    LIMIT 30
  `).all() as any[];

  console.log(`\nTotal PGCRs in DB: ${(db.prepare('SELECT COUNT(*) as c FROM pgcrs').get() as any).c}`);
  console.log('\nRecent PGCRs:');
  for (const pgcr of pgcrs) {
    const time = new Date(pgcr.period * 1000).toISOString();
    const raidName = raids[pgcr.raid_key]?.name || pgcr.raid_key || 'UNKNOWN';
    console.log(
      `  ${pgcr.instance_id} | ${raidName} | ${time} | ` +
      `completed=${pgcr.completed} | fromBeginning=${pgcr.activity_was_started_from_beginning} | ` +
      `startPhase=${pgcr.starting_phase_index} | players=${pgcr.player_count}`
    );
  }

  // 3. Show PGCRs with NULL or unrecognized raid_key
  const unknownRaids = db.prepare(`
    SELECT 
      instance_id,
      activity_hash,
      raid_key,
      period,
      completed,
      player_count
    FROM pgcrs
    WHERE raid_key IS NULL
    ORDER BY period DESC
    LIMIT 20
  `).all() as any[];

  if (unknownRaids.length > 0) {
    console.log(`\n[WARNING] PGCRs with NULL raid_key (unrecognized activity hash):`);
    for (const pgcr of unknownRaids) {
      const time = new Date(pgcr.period * 1000).toISOString();
      console.log(
        `  ${pgcr.instance_id} | hash=${pgcr.activity_hash} | ${time} | ` +
        `completed=${pgcr.completed} | players=${pgcr.player_count}`
      );
    }
  }

  // 4. Show distinct activity hashes and their raid_key mappings
  const hashes = db.prepare(`
    SELECT 
      activity_hash,
      raid_key,
      COUNT(*) as count
    FROM pgcrs
    GROUP BY activity_hash
    ORDER BY count DESC
  `).all() as any[];

  console.log('\nActivity hash distribution:');
  for (const h of hashes) {
    const raidName = raids[h.raid_key]?.name || h.raid_key || 'UNMAPPED';
    console.log(`  hash=${h.activity_hash} -> ${raidName} (${h.count} PGCRs)`);
  }

  // 5. Check what the leaderboard query would return for different time windows
  for (const hours of [2, 4, 8, 24, 48]) {
    const cutoff = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

    const fullClears = db.prepare(`
      SELECT COUNT(DISTINCT p.instance_id) as count
      FROM pgcrs p
      WHERE p.period >= ?
        AND p.completed = 1
        AND (p.activity_was_started_from_beginning = 1 OR p.starting_phase_index = 0)
    `).get(cutoff) as any;

    const allCompletions = db.prepare(`
      SELECT COUNT(DISTINCT p.instance_id) as count
      FROM pgcrs p
      WHERE p.period >= ?
        AND p.completed = 1
    `).get(cutoff) as any;

    const allPGCRs = db.prepare(`
      SELECT COUNT(*) as count
      FROM pgcrs
      WHERE period >= ?
    `).get(cutoff) as any;

    console.log(
      `\n  Last ${hours}h: ${allPGCRs.count} total PGCRs, ` +
      `${allCompletions.count} completed, ${fullClears.count} full clears`
    );
  }

  // 6. Check pgcr_players entries
  const playerEntries = db.prepare(`
    SELECT 
      pp.membership_id,
      pp.display_name,
      pp.completed,
      p.raid_key,
      p.period,
      p.activity_was_started_from_beginning,
      p.starting_phase_index
    FROM pgcr_players pp
    JOIN pgcrs p ON pp.instance_id = p.instance_id
    ORDER BY p.period DESC
    LIMIT 20
  `).all() as any[];

  console.log('\nRecent pgcr_player entries:');
  for (const entry of playerEntries) {
    const time = new Date(entry.period * 1000).toISOString();
    const raidName = raids[entry.raid_key]?.name || entry.raid_key || 'UNKNOWN';
    console.log(
      `  ${entry.display_name || entry.membership_id} | ${raidName} | ${time} | ` +
      `playerCompleted=${entry.completed} | fromBeginning=${entry.activity_was_started_from_beginning} | ` +
      `startPhase=${entry.starting_phase_index}`
    );
  }

  // 7. Compare full clear detection methods
  console.log('\n\nFull clear detection comparison:');
  for (const hours of [4, 8, 24, 48]) {
    const cutoff = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

    const methodA = db.prepare(`
      SELECT COUNT(DISTINCT instance_id) as count FROM pgcrs
      WHERE period >= ? AND completed = 1
        AND (activity_was_started_from_beginning = 1 OR starting_phase_index = 0)
    `).get(cutoff) as any;

    const methodB = db.prepare(`
      SELECT COUNT(DISTINCT instance_id) as count FROM pgcrs
      WHERE period >= ? AND completed = 1
        AND activity_was_started_from_beginning = 1
    `).get(cutoff) as any;

    const methodC = db.prepare(`
      SELECT COUNT(DISTINCT instance_id) as count FROM pgcrs
      WHERE period >= ? AND completed = 1
    `).get(cutoff) as any;

    console.log(
      `  Last ${hours}h: ` +
      `fromBeginning=1 only: ${methodB.count} | ` +
      `fromBeginning=1 OR startPhase=0: ${methodA.count} | ` +
      `all completions: ${methodC.count}`
    );
  }

  // 8. Show breakdown of completed PGCRs by fromBeginning flag
  const breakdown = db.prepare(`
    SELECT 
      activity_was_started_from_beginning as fromBeginning,
      completed,
      COUNT(*) as count
    FROM pgcrs
    GROUP BY activity_was_started_from_beginning, completed
    ORDER BY completed DESC, activity_was_started_from_beginning DESC
  `).all() as any[];

  console.log('\nPGCR breakdown by completed + fromBeginning:');
  for (const row of breakdown) {
    console.log(
      `  completed=${row.completed} fromBeginning=${row.fromBeginning}: ${row.count} PGCRs`
    );
  }

  // 9. Check specific seed players
  const seedIds = ['4611686018469615924',
    '4611686018533113181',
    '4611686018437585442',
    '4611686018431717403',
    '4611686018452637862',
    '4611686018441319193',
    '4611686018501949714',
    '4611686018530726821',
    '4611686018506277701',
    '4611686018436929273'
  ];

  if (seedIds.length > 0) {
    console.log('\nSeed player PGCR check:');
    for (const seedId of seedIds) {
      const playerInfo = db.prepare(
        'SELECT display_name, bungie_global_display_name, last_crawled_at FROM players WHERE membership_id = ?'
      ).get(seedId) as any;

      const pgcrCount = db.prepare(`
        SELECT COUNT(*) as count FROM pgcr_players WHERE membership_id = ?
      `).get(seedId) as any;

      const completedCount = db.prepare(`
        SELECT COUNT(*) as count FROM pgcr_players pp
        JOIN pgcrs p ON pp.instance_id = p.instance_id
        WHERE pp.membership_id = ? AND pp.completed = 1 AND p.completed = 1
      `).get(seedId) as any;

      const freshClears = db.prepare(`
        SELECT COUNT(*) as count FROM pgcr_players pp
        JOIN pgcrs p ON pp.instance_id = p.instance_id
        WHERE pp.membership_id = ?
          AND pp.completed = 1
          AND p.completed = 1
          AND p.activity_was_started_from_beginning = 1
      `).get(seedId) as any;

      const name = playerInfo?.bungie_global_display_name || playerInfo?.display_name || seedId;
      const crawled = playerInfo?.last_crawled_at
        ? new Date(playerInfo.last_crawled_at * 1000).toISOString()
        : 'never';

      console.log(`  ${name} (${seedId}):`);
      console.log(`    Last crawled: ${crawled}`);
      console.log(`    Total PGCRs: ${pgcrCount.count}`);
      console.log(`    Completed raids: ${completedCount.count}`);
      console.log(`    Fresh full clears: ${freshClears.count}`);
    }
  }

  closeDb();
}

main();
