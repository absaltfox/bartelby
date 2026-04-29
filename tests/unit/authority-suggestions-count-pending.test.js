'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

describe('authorityLinkSuggestionsAsync.countPending', () => {
  let db;

  beforeAll(async () => {
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
  });

  test('returns a number for pending suggestions', async () => {
    const n = await db.authorityLinkSuggestionsAsync.countPending();
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
