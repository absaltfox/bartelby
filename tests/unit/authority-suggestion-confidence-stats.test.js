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

// Pins the job's started_at/completed_at and each suggestion's created_at to
// fixed timestamps instead of relying on real-clock CURRENT_TIMESTAMP, so the
// confidence-window join (database/models/jobs.js authoritySuggestionJobs.getSummaries)
// is exercised deterministically rather than by second-resolution timing luck.
async function setWindow(jobId, startedAt, completedAt) {
  await db.runAsync(`
    UPDATE authority_suggestion_jobs SET started_at = ?, completed_at = ? WHERE id = ?
  `, [startedAt, completedAt, jobId]);
}

async function setSuggestionCreatedAt(suggestionId, createdAt) {
  await db.runAsync(`
    UPDATE authority_link_suggestions SET created_at = ? WHERE id = ?
  `, [createdAt, suggestionId]);
}

describe('authority_suggestion summaries expose confidence distribution', () => {
  it('reports min, max, distinct confidence counts across suggestions within the job window, excluding suggestions outside it', async () => {
    const jobId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markDone(jobId, {
      entityCount: 10, candidateCount: 6, suggestionCount: 3, autoApprovedCount: 0
    });
    await setWindow(jobId, '2026-01-01 00:00:00', '2026-01-01 01:00:00');

    const eA = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'A', description: null, properties: {} });
    const eB = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'B', description: null, properties: {} });
    const eC = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'C', description: null, properties: {} });
    const eOutside = await db.entitiesAsync.create({ entity_type: 'person', canonical_name: 'Outside', description: null, properties: {} });
    const auth = await db.authoritiesAsync.create({ authority_type: 'person', canonical_name: 'A', description: null, properties: {} });

    const sA = await db.authorityLinkSuggestionsAsync.createIfMissing({ entity_id: eA, suggested_authority_id: auth, confidence: 0.81, match_method: 'embedding' });
    const sB = await db.authorityLinkSuggestionsAsync.createIfMissing({ entity_id: eB, suggested_authority_id: auth, confidence: 0.79, match_method: 'embedding' });
    const sC = await db.authorityLinkSuggestionsAsync.createIfMissing({ entity_id: eC, suggested_authority_id: auth, confidence: 0.92, match_method: 'embedding' });
    await setSuggestionCreatedAt(sA, '2026-01-01 00:10:00');
    await setSuggestionCreatedAt(sB, '2026-01-01 00:20:00');
    await setSuggestionCreatedAt(sC, '2026-01-01 00:30:00');

    // Written before the job's window opened — must not pollute this job's stats.
    const sOutside = await db.authorityLinkSuggestionsAsync.createIfMissing({ entity_id: eOutside, suggested_authority_id: auth, confidence: 0.5, match_method: 'embedding' });
    await setSuggestionCreatedAt(sOutside, '2025-12-31 23:00:00');

    const summaries = await db.authoritySuggestionJobsAsync.getSummaries({ statusFilter: 'done', limit: 20 });
    const target = summaries.find((s) => s.id === jobId);
    expect(target).toBeTruthy();
    expect(target.confidence_min).toBeCloseTo(0.79);
    expect(target.confidence_max).toBeCloseTo(0.92);
    expect(target.confidence_distinct_count).toBe(3);
  });

  it('reports null/zero confidence stats for a job with no suggestions in its window', async () => {
    const jobId = await db.authoritySuggestionJobsAsync.create({ collection_id: null });
    await db.authoritySuggestionJobsAsync.markDone(jobId, {
      entityCount: 0, candidateCount: 0, suggestionCount: 0, autoApprovedCount: 0
    });
    await setWindow(jobId, '2026-02-01 00:00:00', '2026-02-01 01:00:00');

    const summaries = await db.authoritySuggestionJobsAsync.getSummaries({ statusFilter: 'done', limit: 20 });
    const target = summaries.find((s) => s.id === jobId);
    expect(target).toBeTruthy();
    expect(target.confidence_min).toBeNull();
    expect(target.confidence_max).toBeNull();
    expect(target.confidence_distinct_count).toBe(0);
  });
});
