'use strict';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
  await db.runAsync(`INSERT INTO collections (id, name) VALUES (1, 'Coll')`);
  const id = await db.titleBackfillJobsAsync.create({ collection_id: 1 });
  await db.titleBackfillJobsAsync.claimNextQueued();
  await db.titleBackfillJobsAsync.markFailed(id, 'boom');
}, 60_000);

describe('admin jobs page: title_backfill type', () => {
  it('appears in typeCounts and status counts', async () => {
    const { counts, typeCounts } = await db.adminJobsAsync.getCounts('all', 'all');
    expect(typeCounts.title_backfill).toBe(1);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
  });

  it('appears in getPage with job_type and subject_label', async () => {
    const rows = await db.adminJobsAsync.getPage(50, 0, 'all', 'title_backfill');
    expect(rows.length).toBe(1);
    expect(rows[0].job_type).toBe('title_backfill');
    expect(rows[0].subject_label).toBe('Coll');
  });

  it('type filter normalization accepts title_backfill with a status filter', async () => {
    const rows = await db.adminJobsAsync.getPage(50, 0, 'failed', 'title_backfill');
    expect(rows.length).toBe(1);
  });
});
