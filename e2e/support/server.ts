/**
 * Where the app under test listens. One definition, because three things have
 * to agree on it: playwright.config.ts (the `next start` port and `baseURL`),
 * and e2e/support/write-request.ts (the Origin the same-origin guard must
 * accept). A port change that reached only some of them would surface as a 403
 * in client-write-guard.spec.ts, which reads like a guard bug rather than a
 * config drift.
 *
 * 3100 keeps the suite clear of the dev server on 3000. Imports nothing — this
 * module is loaded at config load, before the fixture database is minted.
 */
export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
