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

describe('authoritySuggestionJobsAsync.retry', () => {
  it('creates a new queued job with the same params and preserves the failed row', async () => {
    const failedId = await db.authoritySuggestionJobsAsync.create({
      collection_id: null,
      fuzzy_threshold: 0.55,
      pending_threshold: 0.7,
      auto_approve_threshold: 0.9,
      requested_by_user_id: null
    });
    await db.authoritySuggestionJobsAsync.markFailed(failedId, 'Protobuf parsing failed.');

    const result = await db.authoritySuggestionJobsAsync.retry(failedId);

    expect(result.status).toBe('queued');
    expect(result.newJobId).toEqual(expect.any(Number));
    expect(result.newJobId).not.toBe(failedId);

    const failed = await db.authoritySuggestionJobsAsync.getById(failedId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Protobuf parsing failed.');

    const fresh = await db.authoritySuggestionJobsAsync.getById(result.newJobId);
    expect(fresh.status).toBe('queued');
    expect(fresh.collection_id).toBe(null);
    expect(fresh.fuzzy_threshold).toBeCloseTo(0.55);
    expect(fresh.pending_threshold).toBeCloseTo(0.7);
    expect(fresh.auto_approve_threshold).toBeCloseTo(0.9);
  });

  it('is idempotent: returns {status:"already_queued"} when same collection scope already has pending/running', async () => {
    const collectionId = await db.collectionsAsync.create({
      name: 'Idempotent Retry Test', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });
    const failedId = await db.authoritySuggestionJobsAsync.create({ collection_id: collectionId });
    await db.authoritySuggestionJobsAsync.markFailed(failedId, 'boom');

    const first = await db.authoritySuggestionJobsAsync.retry(failedId);
    expect(first.status).toBe('queued');

    const second = await db.authoritySuggestionJobsAsync.retry(failedId);
    expect(second.status).toBe('already_queued');
    expect(second.existingJobId).toBe(first.newJobId);
  });

  it('rejects retry on a non-failed job', async () => {
    const queuedId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    const result = await db.authoritySuggestionJobsAsync.retry(queuedId);
    expect(result.status).toBe('not_failed');
  });

  it('rejects retry on a missing job', async () => {
    const result = await db.authoritySuggestionJobsAsync.retry(999999);
    expect(result.status).toBe('not_found');
  });
});
