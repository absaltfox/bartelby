'use strict';

describe('worker-extraction relationship-type alias coercion', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function buildMocks({ entities, relationships, aliasResolveReturns, relationshipTypesResolveReturns = {} }) {
    const logLine = jest.fn(async () => {});
    const createdRelationships = [];
    const relationshipsCreate = jest.fn(async (rel) => {
      createdRelationships.push(rel);
      return createdRelationships.length;
    });
    const markDone = jest.fn(async () => {});
    const appendLog = jest.fn(async () => {});

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3, COOLDOWN_MS: 0,
      isTransientError: () => false,
      sleep: async () => {},
      makeExtractionLogger: () => logLine,
      resolveRuntimeConfig: async () => ({ providerName: 'test', temperature: 0.2, runtimeConfig: {} })
    }));

    let entityIdCounter = 0;
    const extractionJobs = {
      claimNextQueued: jest.fn(async () => ({
        id: 1, transcript_id: 5, document_id: 7, provider: 'test',
        model: 'test', temperature: 0.2, reset_existing: 0, job_kind: 'single'
      })),
      appendLog, markDone, markFailed: async () => {}, requeueForRetry: async () => {},
      updateBatchRemote: async () => {}, updateBatchProgress: async () => {}
    };

    jest.doMock('../../database/db', () => ({
      extractionJobs,
      transcriptsAsync: { getById: async () => ({ id: 5, content: 'Test content.' }) },
      documentsAsync: { getById: async () => ({ id: 7, metadata: {} }) },
      entities: { create: async () => ++entityIdCounter, search: async () => [] },
      entityAliases: { createIfMissing: async () => {} },
      dateExpressions: { createIfMissing: async () => 1 },
      relationships: { create: relationshipsCreate, findExisting: async () => null },
      relationshipTypes: { resolve: jest.fn(async (type) => relationshipTypesResolveReturns[type] ?? null), create: async () => {} },
      relationshipTypeAliasesAsync: {
        resolve: jest.fn(async (aliasType) => aliasResolveReturns[aliasType] ?? null)
      },
      citations: { create: async () => 1 },
      authorityGenericTermsAsync: { listActive: async () => [] },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: async () => true, create: async () => 1 },
      documentCollectionsAsync: { getByDocumentId: async () => [] }
    }));

    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: async () => ({
        entities, dates: [], relationships, paradata: { model: 'test' }
      })
    }));

    return { createdRelationships, logLine };
  }

  it('coerces alias to canonical type (e.g., "mentions" → "mentioned_in")', async () => {
    const { createdRelationships } = buildMocks({
      entities: [
        { mention: 'A', normalized: 'A', entity_type: 'person', span_start: 0, span_end: 1, confidence: 0.9, genericity: 'specific' },
        { mention: 'B', normalized: 'B', entity_type: 'person', span_start: 2, span_end: 3, confidence: 0.9, genericity: 'specific' }
      ],
      relationships: [
        { source_mention: 'A', target_mention: 'B', type: 'mentions', confidence: 0.9 }
      ],
      aliasResolveReturns: { 'mentions': 'mentioned_in' }
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships).toHaveLength(1);
    expect(createdRelationships[0].relationship_type).toBe('mentioned_in');
  });

  it('falls back to "related_to" when type is unknown, preserving original in properties', async () => {
    const { createdRelationships, logLine } = buildMocks({
      entities: [
        { mention: 'A', normalized: 'A', entity_type: 'person', span_start: 0, span_end: 1, confidence: 0.9, genericity: 'specific' },
        { mention: 'B', normalized: 'B', entity_type: 'person', span_start: 2, span_end: 3, confidence: 0.9, genericity: 'specific' }
      ],
      relationships: [
        { source_mention: 'A', target_mention: 'B', type: 'arbitrary_llm_invented', confidence: 0.9 }
      ],
      aliasResolveReturns: {}
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships).toHaveLength(1);
    expect(createdRelationships[0].relationship_type).toBe('related_to');
    const props = typeof createdRelationships[0].properties === 'string'
      ? JSON.parse(createdRelationships[0].properties)
      : (createdRelationships[0].properties || {});
    expect(props.original_relationship_type).toBe('arbitrary_llm_invented');
    const logs = logLine.mock.calls.map(c => c[0]);
    expect(logs.some(l => /coerced.+related_to/.test(l))).toBe(true);
  });

  it('preserves canonical relationship types (e.g., "authored") via relationship_types fallback (post-fix)', async () => {
    const { createdRelationships } = buildMocks({
      entities: [
        { mention: 'A', normalized: 'A', entity_type: 'person', span_start: 0, span_end: 1, confidence: 0.9, genericity: 'specific' },
        { mention: 'B', normalized: 'B', entity_type: 'place', span_start: 2, span_end: 3, confidence: 0.9, genericity: 'specific' }
      ],
      relationships: [
        { source_mention: 'A', target_mention: 'B', type: 'authored', confidence: 0.9 }
      ],
      aliasResolveReturns: {},  // no alias mapping
      relationshipTypesResolveReturns: { 'authored': 'authored' }  // stage 2 fallback returns canonical
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships).toHaveLength(1);
    expect(createdRelationships[0].relationship_type).toBe('authored');
  });
});
