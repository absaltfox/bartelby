'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

// Mock @xenova/transformers to avoid downloading the model in CI
jest.mock('@xenova/transformers', () => ({
  pipeline: jest.fn().mockResolvedValue(
    // Fake embedder: returns a deterministic float32 array based on string content
    async function fakeEmbedder(texts) {
      return texts.map(text => ({
        data: Float32Array.from({ length: 384 }, (_, i) =>
          Math.sin(text.charCodeAt(i % text.length) + i)
        )
      }));
    }
  )
}));

let db;

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  db = require('../../database/db');
}, 30_000);

describe('authority suggestion worker', () => {
  it('creates pending suggestions for entities with similar names across documents', async () => {
    const { runAuthoritySuggestionWorkerCycle } = require('../../utils/worker-authority-suggestion');

    // Create two documents with overlapping entity names
    const docAId = await db.documentsAsync.create({
      title: 'Suggestion Test Doc A', date_created: '1880-01-01',
      description: null, image_path: '/uploads/sug-a.png', metadata: {}
    });
    const docBId = await db.documentsAsync.create({
      title: 'Suggestion Test Doc B', date_created: '1880-01-02',
      description: null, image_path: '/uploads/sug-b.png', metadata: {}
    });

    // Entity from doc A
    const entityAId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'Alice Reed',
      description: null, properties: {}
    });
    await db.entityAliasesAsync.createIfMissing({ entity_id: entityAId, alias: 'Alice Reed', source: 'extracted' });

    const transcriptAId = await db.transcriptsAsync.create({
      document_id: docAId, content: 'Alice Reed wrote a letter.', transcriber: 'Test',
      version: 1, notes: null, is_best: true
    });
    await db.citationsAsync.create({
      entity_id: entityAId, relationship_id: null, transcript_id: transcriptAId,
      document_id: docAId, passage_start: 0, passage_end: 10, passage_text: 'Alice Reed',
      extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9,
      approval_status: 'approved', approval_method: 'manual'
    });

    // Entity from doc B — similar name, different entity row
    const entityBId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'Alice Reed',
      description: null, properties: {}
    });
    await db.entityAliasesAsync.createIfMissing({ entity_id: entityBId, alias: 'A. Reed', source: 'extracted' });

    const transcriptBId = await db.transcriptsAsync.create({
      document_id: docBId, content: 'A. Reed replied.', transcriber: 'Test',
      version: 1, notes: null, is_best: true
    });
    await db.citationsAsync.create({
      entity_id: entityBId, relationship_id: null, transcript_id: transcriptBId,
      document_id: docBId, passage_start: 0, passage_end: 7, passage_text: 'A. Reed',
      extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9,
      approval_status: 'approved', approval_method: 'manual'
    });

    // Queue and run a full-corpus suggestion job with a low auto_approve_threshold
    // so the mocked embedder produces pending suggestions (not auto-approvals)
    const jobId = await db.authoritySuggestionJobsAsync.create({
      collection_id: null,
      fuzzy_threshold: 0.3,        // low so token-overlap 'alice'+'reed' qualifies
      pending_threshold: 0.01,     // near-zero so mock embedder always triggers suggestions
      auto_approve_threshold: 2.0  // above 1.0 → nothing auto-approved; all pending
    });

    await runAuthoritySuggestionWorkerCycle();

    const job = await db.authoritySuggestionJobsAsync.getById(jobId);
    expect(job.status).toBe('done');
    expect(job.candidate_count).toBeGreaterThan(0);
    expect(job.suggestion_count).toBeGreaterThan(0);

    // At least one of the two entities should have a suggestion
    const suggestionsA = await db.authorityLinkSuggestionsAsync.getByEntityId(entityAId);
    const suggestionsB = await db.authorityLinkSuggestionsAsync.getByEntityId(entityBId);
    expect(suggestionsA.length + suggestionsB.length).toBeGreaterThan(0);
  });
});
