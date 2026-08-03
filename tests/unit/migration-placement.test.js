'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

// A migration appended to `database/migrations.js` lands *mid-array*, because
// `database/db.js` pushes v51+ onto the same array afterwards. The runner
// applies by array index against `PRAGMA user_version`, so a mid-array
// insertion renumbers the tail and the new migration is skipped on every
// already-migrated database — while a fresh database applies everything from
// zero and looks perfectly healthy. That asymmetry is why the ordinary suite
// cannot catch it; these two assertions can.
//
// Per docs/db-migrations.md ("When you add a migration").

const { MIGRATIONS } = require('../../database/migrations');

const FROZEN_LITERAL_LENGTH = 50;

describe('migration placement', () => {
  it('database/migrations.js still holds only the frozen v1-v50 block', () => {
    // Read before database/db.js has had a chance to push onto the array.
    expect(MIGRATIONS.length).toBe(FROZEN_LITERAL_LENGTH);
  });

  it('an already-migrated database receives the newest migration', async () => {
    jest.resetModules();
    const db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });

    const { MIGRATIONS: withPushes } = require('../../database/migrations');
    expect(withPushes.length).toBeGreaterThan(FROZEN_LITERAL_LENGTH);

    const driver = db.getDb();
    const fresh = await driver.get('PRAGMA user_version');
    expect(Number(fresh.user_version)).toBe(withPushes.length);

    // The probe is a sentinel migration this test appends itself, rather than
    // the side effect of whatever migration happens to be last (#98). Pinning
    // it to the real tail meant every new migration broke this test with an
    // opaque failure, and the cheapest repair — drop the artifact assertion,
    // keep the user_version one — silently guts it: user_version advances even
    // when a migration's SQL fails, because the runner swallows "already
    // exists" errors. Asserting a *fresh* artifact keeps that honest.
    withPushes.push(`
      CREATE TABLE IF NOT EXISTS migration_probe_sentinel (id INTEGER PRIMARY KEY);
    `);
    const latestVersion = withPushes.length;

    try {
      // Reproduce a database deployed on the prior commit: the sentinel's
      // artifact absent, user_version one behind.
      await driver.run('DROP TABLE IF EXISTS migration_probe_sentinel');
      await driver.run(`PRAGMA user_version = ${latestVersion - 1}`);

      await db.initializeSchema({ runStaleJobRecovery: false });

      const upgraded = await driver.get('PRAGMA user_version');
      expect(Number(upgraded.user_version)).toBe(latestVersion);

      const sentinel = await driver.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe_sentinel'`
      );
      expect(sentinel).toBeTruthy();
    } finally {
      withPushes.pop();
      await driver.run('DROP TABLE IF EXISTS migration_probe_sentinel');
      await driver.run(`PRAGMA user_version = ${withPushes.length}`);
    }
  }, 60_000);
});
