import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initializeSchema } from './schema';

const DB_PATH = path.join(process.cwd(), 'data', 'raid-tracker.db');

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
    if (!dbInstance) {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

        dbInstance = new Database(DB_PATH);

        // Performance settings for SQLite
        dbInstance.pragma('journal_mode = WAL');
        dbInstance.pragma('synchronous = NORMAL');
        dbInstance.pragma('cache_size = -64000'); // 64MB cache
        dbInstance.pragma('foreign_keys = ON');

        initializeSchema(dbInstance);

        console.log(`📂 SQLite database initialized at ${DB_PATH}`);
    }
    return dbInstance;
}

export function closeDb(): void {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
        console.log('📂 SQLite database closed');
    }
}
