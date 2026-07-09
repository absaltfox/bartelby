'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

let db;

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
}, 60_000);

it('warns loudly (without refusing to boot) when user_version exceeds MIGRATIONS.length', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  await db.runAsync('PRAGMA user_version = 9999');
  try {
    await db.initializeSchema({ runStaleJobRecovery: false });
    const drift = spy.mock.calls.find((c) => String(c[0]).includes('SCHEMA DRIFT'));
    expect(drift).toBeTruthy();
  } finally {
    spy.mockRestore();
    // restore the real version so later suites are unaffected
    const { MIGRATIONS } = require('../../database/migrations');
    await db.runAsync(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }
});
