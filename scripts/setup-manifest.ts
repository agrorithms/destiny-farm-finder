import 'dotenv/config';
import { updateManifestCache } from '../src/lib/bungie/manifest';
import { closeDb } from '../src/lib/db';

async function main() {
    console.log('========================================');
    console.log('  Destiny Farm Finder — Manifest Setup');
    console.log('========================================\n');

    try {
        await updateManifestCache();
        console.log('\n[INFO] Manifest cache updated successfully.');
        console.log('[INFO] Review data/manifest-cache.json and update raid hashes in');
        console.log('       src/lib/bungie/manifest.ts if needed.');
    } catch (error) {
        console.error('[ERROR] Failed to update manifest:', error);
    } finally {
        closeDb();
    }
}

main();
