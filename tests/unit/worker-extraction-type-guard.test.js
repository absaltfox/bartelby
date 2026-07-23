'use strict';

describe('worker-extraction write-time source/target type guard', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function buildMocks({ entities, relationships, relTypeRows, resolveReturns }) {
    const logLine = jest.fn(async () => {});
    const createdRelationships = [];
    const relationshipsCreate = jest.fn(async (rel) => {
      createdRelationships.push(rel);
      return createdRelationships.length;
    });

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
      appendLog: async () => {}, markDone: async () => {}, markFailed: async () => {},
      requeueForRetry: async () => {}, updateBatchRemote: async () => {}, updateBatchProgress: async () => {}
    };

    jest.doMock('../../database/db', () => ({
      extractionJobs,
      transcriptsAsync: { getById: async () => ({ id: 5, content: 'R. Law requested the Bill on Education.' }) },
      documentsAsync: { getById: async () => ({ id: 7, metadata: {} }) },
      entities: { create: async () => ++entityIdCounter, search: async () => [] },
      entityAliases: { createIfMissing: async () => {} },
      dateExpressions: { createIfMissing: async () => 1 },
      relationships: { create: relationshipsCreate, findExisting: async () => null },
      relationshipTypes: {
        resolve: jest.fn(async (type) => resolveReturns[type] ?? null),
        getAll: jest.fn(async () => relTypeRows),
        create: async () => {}
      },
      relationshipTypeAliasesAsync: { resolve: jest.fn(async () => null) },
      citations: { create: async () => 1 },
      authorityGenericTermsAsync: { listActive: async () => [] },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: async () => true, create: async () => 1 },
      documentCollectionsAsync: { getDateRangeForDocument: async () => null, getByDocumentId: async () => [] }
    }));

    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: async () => ({ entities, dates: [], relationships, paradata: { model: 'test' } })
    }));

    return { createdRelationships, logLine };
  }

  const AUTHORED_ROW = { name: 'authored', source_type: null, target_type: 'artifact' };
  const RELATED_ROW = { name: 'related_to', source_type: null, target_type: null };
  const HOLDS_ROW = { name: 'holds_position', source_type: 'person', target_type: 'role' };

  it('coerces authored -> topic (type mismatch) to related_to, preserving original', async () => {
    const { createdRelationships, logLine } = buildMocks({
      entities: [
        { mention: 'R. Law', normalized: 'R. Law', type: 'person', span_start: 0, span_end: 6, confidence: 0.9, genericity: 'specific' },
        { mention: 'Bill on Education', normalized: 'Bill on Education', type: 'topic', span_start: 18, span_end: 35, confidence: 0.9, genericity: 'specific' }
      ],
      relationships: [
        { source_mention: 'R. Law', target_mention: 'Bill on Education', type: 'authored', evidence_text: 'R. Law requested the Bill on Education', confidence: 0.9 }
      ],
      relTypeRows: [AUTHORED_ROW, RELATED_ROW],
      resolveReturns: { authored: 'authored', related_to: 'related_to' }
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships).toHaveLength(1);
    expect(createdRelationships[0].relationship_type).toBe('related_to');
    const props = typeof createdRelationships[0].properties === 'string'
      ? JSON.parse(createdRelationships[0].properties)
      : (createdRelationships[0].properties || {});
    expect(props.original_relationship_type).toBe('authored');
    const logs = logLine.mock.calls.map(c => c[0]);
    expect(logs.some(l => /violates controlled source\/target types/.test(l))).toBe(true);
  });

  it('keeps authored when the target is an artifact (constraint satisfied)', async () => {
    const { createdRelationships } = buildMocks({
      entities: [
        { mention: 'R. Law', normalized: 'R. Law', type: 'person', span_start: 0, span_end: 6, confidence: 0.9, genericity: 'specific' },
        { mention: 'Bill on Education', normalized: 'Bill on Education', type: 'artifact', span_start: 21, span_end: 38, confidence: 0.9, genericity: 'specific' }
      ],
      relationships: [
        { source_mention: 'R. Law', target_mention: 'Bill on Education', type: 'authored', evidence_text: 'R. Law requested the Bill on Education', confidence: 0.9 }
      ],
      relTypeRows: [AUTHORED_ROW, RELATED_ROW],
      resolveReturns: { authored: 'authored', related_to: 'related_to' }
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships).toHaveLength(1);
    expect(createdRelationships[0].relationship_type).toBe('authored');
  });

  it('does not over-coerce a constrained edge that matches (holds_position person -> role)', async () => {
    const { createdRelationships } = buildMocks({
      entities: [
        { mention: 'R. Law', normalized: 'R. Law', type: 'person', span_start: 0, span_end: 6, confidence: 0.9, genericity: 'specific' },
        { mention: 'Education', normalized: 'Education', type: 'role', span_start: 29, span_end: 38, confidence: 0.9, genericity: 'specific' }
      ],
      relationships: [
        { source_mention: 'R. Law', target_mention: 'Education', type: 'holds_position', evidence_text: 'R. Law requested the Bill on Education', confidence: 0.9 }
      ],
      relTypeRows: [HOLDS_ROW, RELATED_ROW],
      resolveReturns: { holds_position: 'holds_position', related_to: 'related_to' }
    });
    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();
    expect(createdRelationships).toHaveLength(1);
    expect(createdRelationships[0].relationship_type).toBe('holds_position');
  });
});
