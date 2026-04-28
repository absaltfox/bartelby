'use strict';

describe('admin dashboard count helpers', () => {
  let db;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    process.env.NODE_ENV = 'test';

    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
  });

  test('usersAsync.getActiveCount returns only active users', async () => {
    await db.usersAsync.create({
      username: 'a', email: 'a@x', passwordHash: 'x', role: 'user', status: 'active'
    });
    await db.usersAsync.create({
      username: 'b', email: 'b@x', passwordHash: 'x', role: 'user', status: 'pending'
    });
    await db.usersAsync.create({
      username: 'c', email: 'c@x', passwordHash: 'x', role: 'admin', status: 'active'
    });

    const active = await db.usersAsync.getActiveCount();
    expect(typeof active).toBe('number');
    expect(active).toBeGreaterThanOrEqual(2);
  });

  test('usersAsync.getPendingCount returns only pending users', async () => {
    const pending = await db.usersAsync.getPendingCount();
    expect(typeof pending).toBe('number');
    expect(pending).toBeGreaterThanOrEqual(1);
  });

  test('collectionsAsync.getCount returns total collections', async () => {
    const before = await db.collectionsAsync.getCount();
    await db.collectionsAsync.create({
      name: 'X', description: '', is_public: 0, is_world_public: 0, createdBy: 1
    });
    const after = await db.collectionsAsync.getCount();
    expect(after).toBe(before + 1);
  });
});
