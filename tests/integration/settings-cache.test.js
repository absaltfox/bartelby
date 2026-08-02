'use strict';

/**
 * Covers the in-process cache in front of `settingsAsync.getAllPublic()`.
 *
 * The page-shell middleware (server.js) calls it on every request that
 * reaches it — every HTML page view and, because /uploads is excluded from
 * express.static so the authorizing proxy can run, every thumbnail on a
 * browse grid. On remote Turso each call is a network round-trip.
 *
 * The two properties that make the cache safe to keep are asserted here:
 * repeat renders do not re-query, and an admin settings write is visible on
 * the very next render rather than after the TTL.
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, finding P4).
 */

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const request = require('supertest');

async function bootApp() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  const server = require('../../server');
  await server.initApp();
  return { app: server.app, db: require('../../database/db') };
}

/** Counts driver reads matching `pattern` for the duration of `fn`. */
async function countMatchingQueries(db, pattern, fn) {
  const driver = db.getDb();
  const originalAll = driver.all;
  let count = 0;
  driver.all = function countedAll(sql, ...rest) {
    if (pattern.test(String(sql))) count += 1;
    return originalAll.call(this, sql, ...rest);
  };
  try {
    await fn();
  } finally {
    driver.all = originalAll;
  }
  return count;
}

const SETTINGS_READ = /SELECT\s+key,\s*value\s+FROM\s+settings\s*$/i;

describe('public application settings cache', () => {
  let app;
  let db;

  beforeAll(async () => {
    ({ app, db } = await bootApp());
  }, 60_000);

  afterEach(() => {
    db.invalidatePublicSettingsCache();
  });

  it('does not re-read the settings table on a second page render', async () => {
    db.invalidatePublicSettingsCache();

    const firstCount = await countMatchingQueries(db, SETTINGS_READ, async () => {
      const res = await request(app).get('/login');
      expect(res.status).toBe(200);
    });
    const secondCount = await countMatchingQueries(db, SETTINGS_READ, async () => {
      const res = await request(app).get('/login');
      expect(res.status).toBe(200);
    });

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
  });

  it('reflects a settings write on the very next render', async () => {
    const before = await request(app).get('/login');
    expect(before.status).toBe(200);
    expect(before.text).toContain('Bartelby');

    await db.settingsAsync.set('app_name', 'Cache Invalidation Proof');

    const after = await request(app).get('/login');
    expect(after.status).toBe(200);
    expect(after.text).toContain('Cache Invalidation Proof');

    // And the new value is itself cached rather than re-read every time.
    const repeatCount = await countMatchingQueries(db, SETTINGS_READ, async () => {
      const res = await request(app).get('/login');
      expect(res.text).toContain('Cache Invalidation Proof');
    });
    expect(repeatCount).toBe(0);

    await db.settingsAsync.set('app_name', '');
  });

  it('never caches secret setting values', async () => {
    // Written through the driver rather than `settingsAsync.set`, which would
    // require DATA_ENCRYPTION_KEY; the projection under test is what matters.
    await db.getDb().run(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['openai_api_key', 'sk-should-not-be-public']
    );
    db.invalidatePublicSettingsCache();

    const publicSettings = await db.settingsAsync.getAllPublic();
    expect(publicSettings).not.toHaveProperty('openai_api_key');

    // Second (cached) read must have the same shape as the first.
    const cachedSettings = await db.settingsAsync.getAllPublic();
    expect(cachedSettings).not.toHaveProperty('openai_api_key');
    expect(cachedSettings).toEqual(publicSettings);

    await db.getDb().run('DELETE FROM settings WHERE key = ?', ['openai_api_key']);
  });

  it('SETTINGS_CACHE_TTL_MS=0 disables caching entirely', async () => {
    jest.resetModules();
    const previous = process.env.SETTINGS_CACHE_TTL_MS;
    process.env.SETTINGS_CACHE_TTL_MS = '0';
    try {
      const uncachedServer = require('../../server');
      await uncachedServer.initApp();
      const uncachedDb = require('../../database/db');

      const first = await countMatchingQueries(uncachedDb, SETTINGS_READ, async () => {
        const res = await request(uncachedServer.app).get('/login');
        expect(res.status).toBe(200);
      });
      const second = await countMatchingQueries(uncachedDb, SETTINGS_READ, async () => {
        const res = await request(uncachedServer.app).get('/login');
        expect(res.status).toBe(200);
      });

      // Every request reads the table when the cache is switched off.
      expect(first).toBe(1);
      expect(second).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.SETTINGS_CACHE_TTL_MS;
      else process.env.SETTINGS_CACHE_TTL_MS = previous;
    }
  }, 60_000);

  it('hands each caller its own object so res.locals cannot poison the cache', async () => {
    const first = await db.settingsAsync.getAllPublic();
    first.app_name = 'mutated by a caller';

    const second = await db.settingsAsync.getAllPublic();
    expect(second.app_name).not.toBe('mutated by a caller');
  });
});
