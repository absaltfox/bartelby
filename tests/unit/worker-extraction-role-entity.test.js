'use strict';

describe('worker-extraction role entity type (E1.1)', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  it('creates a role entity for an LLM-emitted entity with type "role"', async () => {
    const createdEntities = [];
    const entitiesCreate = jest.fn(async (entityData) => {
      createdEntities.push(entityData);
      return createdEntities.length;
    });
    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3, COOLDOWN_MS: 0,
      isTransientError: () => false, sleep: async () => {},
      makeExtractionLogger: () => async () => {},
      resolveRuntimeConfig: async () => ({ providerName: 'test', temperature: 0.2, runtimeConfig: {} })
    }));
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
      transcriptsAsync: { getById: async () => ({ id: 5, content: 'Superintendent of Education shall report.' }) },
      documentsAsync: { getById: async () => ({ id: 7, metadata: {} }) },
      entities: { create: entitiesCreate, search: async () => [] },
      entityAliases: { createIfMissing: async () => {} },
      dateExpressions: { createIfMissing: async () => 1 },
      relationships: { create: async () => 1, findExisting: async () => null },
      relationshipTypes: { resolve: async () => null, create: async () => {} },
      relationshipTypeAliasesAsync: { resolve: async () => null },
      citations: { create: async () => 1 },
      authorityGenericTermsAsync: { listActive: async () => [] },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: async () => true, create: async () => 1 },
      documentCollectionsAsync: { getDateRangeForDocument: async () => null, getByDocumentId: async () => [] }
    }));
    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: async () => ({
        entities: [{
          mention: 'Superintendent of Education', normalized: 'Superintendent of Education',
          type: 'role', span_start: 0, span_end: 28, confidence: 0.9, genericity: 'specific'
        }],
        dates: [], relationships: [], paradata: { model: 'test' }
      })
    }));

    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdEntities).toHaveLength(1);
    expect(createdEntities[0].entity_type).toBe('role');
    expect(createdEntities[0].canonical_name).toBe('Superintendent of Education');
  });
});
