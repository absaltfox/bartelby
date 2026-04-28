'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';

// The /admin/jobs route used to call getCounts() AND getFilteredCount() in parallel
// (3 + 3 COUNT queries on Turso). The page count can be derived from the counts
// map returned by getCounts, so the second call is redundant. This test locks in
// the derivation so the route stays correct even with no rows in the system.
describe('/admin/jobs filteredTotal derivation from counts', () => {
  let db;

  beforeAll(async () => {
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
  });

  test('counts.total is a number for every type filter, and counts[bucket] is a number for every status bucket', async () => {
    const types = ['all', 'transcription', 'import', 'extraction'];
    const buckets = ['queued', 'running', 'done', 'failed'];

    for (const typeFilter of types) {
      const { counts } = await db.adminJobsAsync.getCounts('all', typeFilter);
      expect(typeof counts.total).toBe('number');
      expect(Number.isFinite(counts.total)).toBe(true);
      for (const bucket of buckets) {
        expect(typeof counts[bucket]).toBe('number');
        expect(Number.isFinite(counts[bucket])).toBe(true);
      }
    }
  });

  test('derived filteredTotal is finite for every status×type combination', async () => {
    const statuses = ['all', 'queued', 'running', 'done', 'failed'];
    const types = ['all', 'transcription', 'import', 'extraction'];

    for (const filter of statuses) {
      for (const typeFilter of types) {
        const { counts } = await db.adminJobsAsync.getCounts(filter, typeFilter);
        const derived = filter === 'all' ? counts.total : (counts[filter] || 0);
        expect(typeof derived).toBe('number');
        expect(Number.isFinite(derived)).toBe(true);
        expect(derived).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
