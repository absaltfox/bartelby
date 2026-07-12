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
  await db.runAsync(`INSERT INTO collections (id, name) VALUES (1, 'Test Coll')`);
}, 60_000);

describe('titleBackfillJobsAsync model', () => {
  let jobId;

  it('creates a queued job and de-dupes queued/running per collection', async () => {
    jobId = await db.titleBackfillJobsAsync.create({ collection_id: 1, requested_by_user_id: null });
    expect(jobId).toBeGreaterThan(0);
    expect(await db.titleBackfillJobsAsync.hasPendingOrRunningForCollection(1)).toBe(true);
    expect(await db.titleBackfillJobsAsync.hasPendingOrRunningForCollection(999)).toBe(false);
  });

  it('claimNextQueued flips to running exactly once', async () => {
    const claimed = await db.titleBackfillJobsAsync.claimNextQueued();
    expect(claimed.id).toBe(jobId);
    expect(claimed.status).toBe('running');
    expect(await db.titleBackfillJobsAsync.claimNextQueued()).toBeNull();
  });

  it('updateProgress persists counters; markFailed preserves them', async () => {
    await db.titleBackfillJobsAsync.updateProgress(jobId, {
      docs_total: 10, docs_processed: 4, titles_updated: 3, summaries_updated: 2, docs_failed: 1
    });
    await db.titleBackfillJobsAsync.markFailed(jobId, '1 of 10 documents failed; see job log.');
    const row = await db.titleBackfillJobsAsync.getById(jobId);
    expect(row.status).toBe('failed');
    expect(row.docs_total).toBe(10);
    expect(row.titles_updated).toBe(3);
    expect(row.error).toMatch(/1 of 10/);
  });

  it('retry creates a NEW queued row and preserves the failed one; de-dupes', async () => {
    const result = await db.titleBackfillJobsAsync.retry(jobId);
    expect(result.status).toBe('created');
    expect(result.newJobId).not.toBe(jobId);
    expect((await db.titleBackfillJobsAsync.getById(jobId)).status).toBe('failed');
    const again = await db.titleBackfillJobsAsync.retry(jobId);
    expect(again.status).toBe('already_queued');
    expect(again.existingJobId).toBe(result.newJobId);
  });

  it('getCounts and getSummaries expose the family', async () => {
    const counts = await db.titleBackfillJobsAsync.getCounts();
    expect(counts.total).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.queued).toBe(1);
    const rows = await db.titleBackfillJobsAsync.getSummaries({ statusFilter: 'all', limit: 50 });
    expect(rows.length).toBe(2);
    expect(rows[0].job_type).toBe('title_backfill');
    expect(rows[0].subject_label).toBe('Test Coll');
  });
});
