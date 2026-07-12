'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

jest.mock('@huggingface/transformers', () => ({
  pipeline: jest.fn().mockResolvedValue(
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

describe('authority suggestion worker dedup', () => {
  it('calls assignAuthority once per unique entity even when multiple pairs share the same name', async () => {
    const { runAuthoritySuggestionWorkerCycle } = require('../../utils/worker-authority-suggestion');

    const collectionId = await db.collectionsAsync.create({
      name: 'Dedup Test Collection', description: null,
      is_public: false, is_world_public: false,
      allow_export: false, auto_group_pages: false, createdBy: null
    });

    // Three person entities with identical canonical names — produces C(3,2)=3 pairs,
    // all auto_approve_exact. Without dedup the worker calls assignAuthority 6 times
    // (entityA + entityB for each pair); with dedup it should call it exactly 3 times.
    const entityIds = [];
    for (let i = 0; i < 3; i++) {
      const docId = await db.documentsAsync.create({
        title: `Dedup Doc ${i}`, date_created: '1900-01-01',
        description: null, image_path: `/uploads/dedup-${i}.png`, metadata: {}
      });
      await db.documentCollectionsAsync.add(docId, collectionId);

      const entityId = await db.entitiesAsync.create({
        entity_type: 'person', canonical_name: 'Dedup Test McKenzie',
        description: null, properties: {}
      });
      entityIds.push(entityId);

      const txId = await db.transcriptsAsync.create({
        document_id: docId, content: 'Dedup Test McKenzie wrote this.',
        transcriber: 'Test', version: 1, notes: null, is_best: true
      });
      await db.citationsAsync.create({
        entity_id: entityId, relationship_id: null, transcript_id: txId,
        document_id: docId, passage_start: 0, passage_end: 20,
        passage_text: 'Dedup Test McKenzie',
        extraction_method: 'test', extraction_model: 'jest', confidence: 1,
        approval_status: 'approved', approval_method: 'manual'
      });
    }

    await db.authoritySuggestionJobsAsync.create({
      collection_id: collectionId,
      fuzzy_threshold: 0.3,
      pending_threshold: -1,    // accept any similarity
      auto_approve_threshold: 2 // above max cosine — only exact-name path triggers
    });

    const spy = jest.spyOn(db.entitiesAsync, 'assignAuthority');
    spy.mockClear();

    await runAuthoritySuggestionWorkerCycle();

    // Should be called exactly once per unique entity (3), not twice per entity (6)
    expect(spy).toHaveBeenCalledTimes(entityIds.length);

    spy.mockRestore();

    // All three entities end up on the same authority
    const resolved = await Promise.all(entityIds.map(id => db.entitiesAsync.getById(id)));
    const authorityIds = resolved.map(e => e.authority_id).filter(Boolean);
    expect(authorityIds).toHaveLength(3);
    expect(new Set(authorityIds).size).toBe(1);
  });
});
