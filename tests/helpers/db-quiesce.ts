import { updateMaintenanceState } from '../../src/lib/maintenance/state';

/**
 * Runs `fn` with the database quiesced, the way a real maintenance window does.
 *
 * `getDb()` reads this flag on every call and throws DatabaseMaintenanceError
 * itself, so every route's 503 path is exercised through the production
 * mechanism. The alternative — spying on whichever query a route happens to
 * call first — pins each test to one route's internal call order and needs an
 * ADR 0004 exception per route; this needs neither.
 *
 * State lives in maintenance-state.json under the directory holding
 * RAID_TRACKER_DB_PATH, so it is already isolated per test file.
 */
export async function withDbQuiesced<T>(fn: () => Promise<T>): Promise<T> {
    setQuiesce(true);
    try {
        return await fn();
    } finally {
        setQuiesce(false);
    }
}

function setQuiesce(dbQuiesceActive: boolean): void {
    updateMaintenanceState((state) => ({ ...state, dbQuiesceActive }));
}
