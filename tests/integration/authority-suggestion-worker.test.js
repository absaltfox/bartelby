'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

// Mock @huggingface/transformers to avoid downloading the model in CI
jest.mock('@huggingface/transformers', () => ({
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
}, 180_000);

describe('authority suggestion worker', () => {
  it('creates pending suggestions for entities with similar names across documents', async () => {
    const { runAuthoritySuggestionWorkerCycle } = require('../../utils/worker-authority-suggestion');
    const collectionId = await db.collectionsAsync.create({
      name: 'Suggestion Test Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    // Create two documents with overlapping entity names
    const docAId = await db.documentsAsync.create({
      title: 'Suggestion Test Doc A', date_created: '1880-01-01',
      description: null, image_path: '/uploads/sug-a.png', metadata: {}
    });
    const docBId = await db.documentsAsync.create({
      title: 'Suggestion Test Doc B', date_created: '1880-01-02',
      description: null, image_path: '/uploads/sug-b.png', metadata: {}
    });
    await db.documentCollectionsAsync.add(docAId, collectionId);
    await db.documentCollectionsAsync.add(docBId, collectionId);

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
      entity_type: 'person', canonical_name: 'A Reed',
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
      collection_id: collectionId,
      fuzzy_threshold: 0.3,        // low so token-overlap 'alice'+'reed' qualifies
      pending_threshold: -1,       // low so mock embedder always triggers suggestions
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

  it('auto-approves exact place matches at the pending threshold', async () => {
    const { runAuthoritySuggestionWorkerCycle } = require('../../utils/worker-authority-suggestion');
    const collectionId = await db.collectionsAsync.create({
      name: 'Exact Place Test Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    const docAId = await db.documentsAsync.create({
      title: 'Exact Place Doc A', date_created: '1881-01-01',
      description: null, image_path: '/uploads/exact-place-a.png', metadata: {}
    });
    const docBId = await db.documentsAsync.create({
      title: 'Exact Place Doc B', date_created: '1881-01-02',
      description: null, image_path: '/uploads/exact-place-b.png', metadata: {}
    });
    await db.documentCollectionsAsync.add(docAId, collectionId);
    await db.documentCollectionsAsync.add(docBId, collectionId);
    const entityAId = await db.entitiesAsync.create({
      entity_type: 'place', canonical_name: 'Exact Test Victoria, British Columbia',
      description: null, properties: {}
    });
    const entityBId = await db.entitiesAsync.create({
      entity_type: 'place', canonical_name: 'Exact Test Victoria, British Columbia',
      description: null, properties: {}
    });
    const transcriptAId = await db.transcriptsAsync.create({
      document_id: docAId, content: 'Exact Test Victoria, British Columbia appears.',
      transcriber: 'Test', version: 1, notes: null, is_best: true
    });
    const transcriptBId = await db.transcriptsAsync.create({
      document_id: docBId, content: 'Exact Test Victoria, British Columbia appears again.',
      transcriber: 'Test', version: 1, notes: null, is_best: true
    });
    await db.citationsAsync.create({
      entity_id: entityAId, relationship_id: null, transcript_id: transcriptAId,
      document_id: docAId, passage_start: 0, passage_end: 10, passage_text: 'Exact Test Victoria',
      extraction_method: 'test', extraction_model: 'jest', confidence: 1,
      approval_status: 'approved', approval_method: 'manual'
    });
    await db.citationsAsync.create({
      entity_id: entityBId, relationship_id: null, transcript_id: transcriptBId,
      document_id: docBId, passage_start: 0, passage_end: 10, passage_text: 'Exact Test Victoria',
      extraction_method: 'test', extraction_model: 'jest', confidence: 1,
      approval_status: 'approved', approval_method: 'manual'
    });
    const jobId = await db.authoritySuggestionJobsAsync.create({
      collection_id: collectionId,
      fuzzy_threshold: 0.3,
      pending_threshold: -1,
      auto_approve_threshold: 2
    });

    await runAuthoritySuggestionWorkerCycle();
    const job = await db.authoritySuggestionJobsAsync.getById(jobId);
    if (job.status === 'queued') await runAuthoritySuggestionWorkerCycle();

    const entityA = await db.entitiesAsync.getById(entityAId);
    const entityB = await db.entitiesAsync.getById(entityBId);
    expect(entityA.authority_id).toBeTruthy();
    expect(entityB.authority_id).toBe(entityA.authority_id);
  });

  it('skips active generic authority terms', async () => {
    const { runAuthoritySuggestionWorkerCycle } = require('../../utils/worker-authority-suggestion');
    const collectionId = await db.collectionsAsync.create({
      name: 'Generic Term Test Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    await db.authorityGenericTermsAsync.createManual({
      term: 'Worker Generic High School',
      entity_type: 'organization',
      userId: null
    });
    const docAId = await db.documentsAsync.create({
      title: 'Generic Term Doc A', date_created: '1882-01-01',
      description: null, image_path: '/uploads/generic-a.png', metadata: {}
    });
    const docBId = await db.documentsAsync.create({
      title: 'Generic Term Doc B', date_created: '1882-01-02',
      description: null, image_path: '/uploads/generic-b.png', metadata: {}
    });
    await db.documentCollectionsAsync.add(docAId, collectionId);
    await db.documentCollectionsAsync.add(docBId, collectionId);
    const entityAId = await db.entitiesAsync.create({
      entity_type: 'organization', canonical_name: 'Worker Generic High School',
      description: null, properties: {}
    });
    const entityBId = await db.entitiesAsync.create({
      entity_type: 'organization', canonical_name: 'Worker Generic High School',
      description: null, properties: {}
    });
    const transcriptAId = await db.transcriptsAsync.create({
      document_id: docAId, content: 'Worker Generic High School appears.',
      transcriber: 'Test', version: 1, notes: null, is_best: true
    });
    const transcriptBId = await db.transcriptsAsync.create({
      document_id: docBId, content: 'Worker Generic High School appears again.',
      transcriber: 'Test', version: 1, notes: null, is_best: true
    });
    await db.citationsAsync.create({
      entity_id: entityAId, relationship_id: null, transcript_id: transcriptAId,
      document_id: docAId, passage_start: 0, passage_end: 10, passage_text: 'Worker Generic High School',
      extraction_method: 'test', extraction_model: 'jest', confidence: 1,
      approval_status: 'approved', approval_method: 'manual'
    });
    await db.citationsAsync.create({
      entity_id: entityBId, relationship_id: null, transcript_id: transcriptBId,
      document_id: docBId, passage_start: 0, passage_end: 10, passage_text: 'Worker Generic High School',
      extraction_method: 'test', extraction_model: 'jest', confidence: 1,
      approval_status: 'approved', approval_method: 'manual'
    });
    await db.authoritySuggestionJobsAsync.create({
      collection_id: collectionId,
      fuzzy_threshold: 0.3,
      pending_threshold: -1,
      auto_approve_threshold: 2
    });

    await runAuthoritySuggestionWorkerCycle();

    const suggestions = await db.authorityLinkSuggestionsAsync.getByEntityId(entityBId);
    const entityB = await db.entitiesAsync.getById(entityBId);
    expect(suggestions).toHaveLength(0);
    expect(entityB.authority_id).toBeNull();
  });
});
