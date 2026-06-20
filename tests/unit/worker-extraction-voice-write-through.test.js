'use strict';

describe('worker-extraction voice write-through', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  function buildMocks({ entities, relationships }) {
    const createdRelationships = [];
    const relationshipsCreate = jest.fn(async (rel) => {
      createdRelationships.push(rel);
      return createdRelationships.length;
    });
    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3, COOLDOWN_MS: 0,
      isTransientError: () => false, sleep: async () => {},
      makeExtractionLogger: () => async () => {},
      resolveRuntimeConfig: async () => ({ providerName: 'test', temperature: 0.2, runtimeConfig: {} })
    }));
    let entityIdCounter = 0;
    jest.doMock('../../database/db', () => ({
      extractionJobs: {
        claimNextQueued: jest.fn(async () => ({
          id: 1, transcript_id: 5, document_id: 7, provider: 'test',
          model: 'test', temperature: 0.2, reset_existing: 0, job_kind: 'single'
        })),
        appendLog: async () => {}, markDone: async () => {},
        markFailed: async () => {}, requeueForRetry: async () => {},
        updateBatchRemote: async () => {}, updateBatchProgress: async () => {}
      },
      transcriptsAsync: { getById: async () => ({ id: 5, content: 'A B C Test content.' }) },
      documentsAsync: { getById: async () => ({ id: 7, metadata: {} }) },
      entities: { create: async () => ++entityIdCounter, search: async () => [] },
      entityAliases: { createIfMissing: async () => {} },
      dateExpressions: { createIfMissing: async () => 1 },
      relationships: { create: relationshipsCreate, findExisting: async () => null },
      relationshipTypes: { resolve: async () => 'authored', create: async () => {} },
      relationshipTypeAliasesAsync: { resolve: async () => 'authored' },
      citations: { create: async () => 1 },
      authorityGenericTermsAsync: { listActive: async () => [] },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: async () => true, create: async () => 1 },
      documentCollectionsAsync: { getByDocumentId: async () => [] },
      graphMaintenance: { getPreExistingCitationIds: async () => [], resetCitationsById: async () => ({}) }
    }));
    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: async () => ({
        entities, dates: [], relationships, paradata: { model: 'test' }
      })
    }));
    return { createdRelationships };
  }

  const baseEntities = [
    { mention: 'A', normalized: 'A', entity_type: 'person', span_start: 0, span_end: 1, confidence: 0.9, genericity: 'specific' },
    { mention: 'B', normalized: 'B', entity_type: 'person', span_start: 2, span_end: 3, confidence: 0.9, genericity: 'specific' },
    { mention: 'C', normalized: 'C', entity_type: 'person', span_start: 4, span_end: 5, confidence: 0.9, genericity: 'specific' }
  ];

  it('defaults voice_role to "author" when LLM omits it', async () => {
    const { createdRelationships } = buildMocks({
      entities: baseEntities,
      relationships: [{ source_mention: 'A', target_mention: 'B', type: 'authored', evidence_text: 'A B', confidence: 0.9 }]
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships[0].voice_role).toBe('author');
  });

  it('respects LLM-emitted speaker voice and resolves voice_attribution_mention to entity id', async () => {
    const { createdRelationships } = buildMocks({
      entities: baseEntities,
      relationships: [{
        source_mention: 'A', target_mention: 'B', type: 'authored', confidence: 0.9,
        evidence_text: 'A B', voice_role: 'speaker', voice_attribution_mention: 'C'
      }]
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships[0].voice_role).toBe('speaker');
    expect(createdRelationships[0].expressed_by_entity_id).toBeGreaterThan(0);
  });

  it('respects LLM-emitted described_subject voice + attribution', async () => {
    const { createdRelationships } = buildMocks({
      entities: baseEntities,
      relationships: [{
        source_mention: 'A', target_mention: 'B', type: 'authored', confidence: 0.9,
        evidence_text: 'A B', voice_role: 'described_subject', voice_attribution_mention: 'C'
      }]
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships[0].voice_role).toBe('described_subject');
    expect(createdRelationships[0].described_subject_entity_id).toBeGreaterThan(0);
  });

  it('drops invalid voice_role values silently (caller falls back to author)', async () => {
    const { createdRelationships } = buildMocks({
      entities: baseEntities,
      relationships: [{
        source_mention: 'A', target_mention: 'B', type: 'authored', confidence: 0.9,
        evidence_text: 'A B', voice_role: 'narrator'
      }]
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships[0].voice_role).toBe('author');
  });
});
