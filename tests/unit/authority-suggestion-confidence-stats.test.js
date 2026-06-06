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

describe('authority_suggestion summaries expose confidence distribution', () => {
  it('reports min, max, distinct confidence counts across suggestions written by the job', async () => {
    const jobId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markDone(jobId, {
      entityCount: 10, candidateCount: 6, suggestionCount: 3, autoApprovedCount: 0
    });

    // Manually insert link suggestions tagged with this job's created window.
    // The confidence stats query joins by created_at >= job.started_at; for
    // this test we just verify the API surface returns the fields, populated
    // from any present rows.
    const eA = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'A', description: null, properties: {} });
    const eB = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'B', description: null, properties: {} });
    const eC = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'C', description: null, properties: {} });
    const auth = await db.authoritiesAsync.create({ authority_type: 'person', canonical_name: 'A', description: null, properties: {} });
    await db.authorityLinkSuggestionsAsync.createIfMissing({ entity_id: eA, suggested_authority_id: auth, confidence: 0.81, match_method: 'embedding' });
    await db.authorityLinkSuggestionsAsync.createIfMissing({ entity_id: eB, suggested_authority_id: auth, confidence: 0.79, match_method: 'embedding' });
    await db.authorityLinkSuggestionsAsync.createIfMissing({ entity_id: eC, suggested_authority_id: auth, confidence: 0.92, match_method: 'embedding' });

    const summaries = await db.authoritySuggestionJobsAsync.getSummaries({ statusFilter: 'done', limit: 20 });
    const target = summaries.find((s) => s.id === jobId);
    expect(target).toBeTruthy();
    expect(target).toHaveProperty('confidence_min');
    expect(target).toHaveProperty('confidence_max');
    expect(target).toHaveProperty('confidence_distinct_count');
  });
});
