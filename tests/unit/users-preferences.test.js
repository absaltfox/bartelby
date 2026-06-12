'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db, userId;

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  db = require('../../database/db');
  userId = await db.usersAsync.create({
    username: 'pref-getter', email: 'pg@t.local', passwordHash: 'x', role: 'user'
  });
}, 60_000);

describe('usersAsync preferences API', () => {
  it('getPreferences returns {} when unset', async () => {
    const prefs = await db.usersAsync.getPreferences(userId);
    expect(prefs).toEqual({});
  });

  it('setPreferences persists a single key', async () => {
    await db.usersAsync.setPreferences(userId, { reviewExtractionsSort: 'rare-type-first' });
    const prefs = await db.usersAsync.getPreferences(userId);
    expect(prefs.reviewExtractionsSort).toBe('rare-type-first');
  });

  it('setPreferences merges with existing keys (does not overwrite the whole object)', async () => {
    await db.usersAsync.setPreferences(userId, { reviewExtractionsSort: 'newest' });
    await db.usersAsync.setPreferences(userId, { theme: 'dark' });
    const prefs = await db.usersAsync.getPreferences(userId);
    expect(prefs.reviewExtractionsSort).toBe('newest');
    expect(prefs.theme).toBe('dark');
  });

  it('setPreferences with null value removes the key', async () => {
    await db.usersAsync.setPreferences(userId, { reviewExtractionsSort: 'newest' });
    await db.usersAsync.setPreferences(userId, { reviewExtractionsSort: null });
    const prefs = await db.usersAsync.getPreferences(userId);
    expect(prefs.reviewExtractionsSort).toBeUndefined();
  });

  it('getPreferences returns {} when the JSON is malformed (graceful)', async () => {
    await db.runAsync('UPDATE users SET preferences = ? WHERE id = ?', ['not-valid-json', userId]);
    const prefs = await db.usersAsync.getPreferences(userId);
    expect(prefs).toEqual({});
  });
});
