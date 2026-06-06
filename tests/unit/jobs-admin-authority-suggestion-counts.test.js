'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  db = require('../../database/db');
}, 60_000);

describe('adminJobsAsync — authority_suggestion type', () => {
  it('includes authority_suggestion in typeCounts on getCounts({status:all, type:all})', async () => {
    const j1 = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markFailed(j1, 'boom');
    const j2 = await db.authoritySuggestionJobsAsync.create({ collection_id: null });

    const { typeCounts } = await db.adminJobsAsync.getCounts('all', 'all');
    expect(typeCounts).toHaveProperty('authority_suggestion');
    expect(typeCounts.authority_suggestion).toBeGreaterThanOrEqual(2);
  });

  it('returns only authority_suggestion rows when typeFilter=authority_suggestion', async () => {
    const failedId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markFailed(failedId, 'Protobuf parsing failed.');

    const jobs = await db.adminJobsAsync.getPage(50, 0, 'failed', 'authority_suggestion');
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.job_type).toBe('authority_suggestion');
    }
    const target = jobs.find((j) => j.id === failedId);
    expect(target).toBeTruthy();
    expect(target.status).toBe('failed');
    expect(target.error).toBe('Protobuf parsing failed.');
  });

  it('decorates rows with a subject_label suitable for the jobs view', async () => {
    const fullCorpusId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    const collectionId = await db.collectionsAsync.create({
      name: 'AS Subject Test', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });
    const scopedId = await db.authoritySuggestionJobsAsync.create({ collection_id: collectionId });

    const jobs = await db.adminJobsAsync.getPage(50, 0, 'all', 'authority_suggestion');
    const full = jobs.find((j) => j.id === fullCorpusId);
    const scoped = jobs.find((j) => j.id === scopedId);
    expect(full.subject_label).toBe('Full corpus');
    expect(scoped.subject_label).toBe('AS Subject Test');
    expect(scoped.collection_id).toBe(collectionId);
  });
});
