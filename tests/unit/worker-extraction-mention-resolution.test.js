'use strict';

describe('worker-extraction mention resolution', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function buildMocks({ entities, dates, relationships }) {
    const logLine = jest.fn(async () => {});
    const markDoneCalls = [];
    const markDone = jest.fn(async (id, args) => { markDoneCalls.push(args); });
    const markFailed = jest.fn(async () => {});
    const appendLog = jest.fn(async () => {});
    const requeueForRetry = jest.fn(async () => {});

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
      appendLog, markDone, markFailed, requeueForRetry,
      updateBatchRemote: async () => {}, updateBatchProgress: async () => {}
    };

    jest.doMock('../../database/db', () => ({
      extractionJobs,
      transcriptsAsync: { getById: async () => ({ id: 5, content: 'Wm. Jessop wrote to Mary on 1872-04-01.' }) },
      documentsAsync: { getById: async () => ({ id: 7, metadata: {} }) },
      entities: { create: async () => ++entityIdCounter, search: async () => [] },
      entityAliases: { createIfMissing: async () => {} },
      dateExpressions: { createIfMissing: async () => 1 },
      relationships: { create: async () => 1, findExisting: async () => null },
      relationshipTypes: { resolve: async () => 'authored', create: async () => {} },
      relationshipTypeAliasesAsync: { resolve: async () => null },
      citations: { create: async () => 1 },
      authorityGenericTermsAsync: { listActive: async () => [] },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: async () => true, create: async () => 1 },
      documentCollectionsAsync: { getDateRangeForDocument: async () => null, getByDocumentId: async () => [] }
    }));

    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: async () => ({
        entities, dates, relationships, paradata: { model: 'test' }
      })
    }));

    return { markDoneCalls, logLine };
  }

  it('resolves a relationship whose source_mention uses an abbreviation variant of the entity mention', async () => {
    // entity mention is the transcript verbatim "Wm. Jessop"; normalized form
    // is "William Jessop"; relationship also uses the verbatim abbreviation.
    const { markDoneCalls, logLine } = buildMocks({
      entities: [{
        mention: 'Wm. Jessop', normalized: 'William Jessop', entity_type: 'person',
        span_start: 0, span_end: 10, confidence: 0.9, genericity: 'specific'
      }, {
        mention: 'Mary', normalized: 'Mary', entity_type: 'person',
        span_start: 20, span_end: 24, confidence: 0.9, genericity: 'specific'
      }],
      dates: [],
      relationships: [{
        source_mention: 'Wm. Jessop', target_mention: 'Mary', type: 'authored',
        evidence_text: 'Wm. Jessop wrote to Mary', confidence: 0.9
      }]
    });

    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();

    expect(markDoneCalls).toHaveLength(1);
    expect(markDoneCalls[0].relationship_count).toBe(1);
    expect(markDoneCalls[0].unresolved_relationship_count).toBe(0);
    const warns = logLine.mock.calls.map(c => c[0]).filter(s => /WARN/.test(s));
    expect(warns.find(w => /Could not resolve relationship/.test(w))).toBeUndefined();
  });

  it('increments unresolved counters when a relationship mention truly does not match', async () => {
    const { markDoneCalls, logLine } = buildMocks({
      entities: [{
        mention: 'Jessop', normalized: 'Jessop', entity_type: 'person',
        span_start: 0, span_end: 6, confidence: 0.9, genericity: 'specific'
      }],
      dates: [],
      relationships: [{
        source_mention: 'Jessop', target_mention: 'Unknown Person', type: 'related_to',
        evidence_text: 'Wm. Jessop wrote to Mary', confidence: 0.9
      }]
    });

    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();

    expect(markDoneCalls).toHaveLength(1);
    expect(markDoneCalls[0].relationship_count).toBe(0);
    expect(markDoneCalls[0].unresolved_relationship_count).toBe(1);
    const warns = logLine.mock.calls.map(c => c[0]).filter(s => /WARN/.test(s));
    expect(warns.some(w => /Could not resolve relationship/.test(w))).toBe(true);
  });

  it('increments unresolved_date_count when a date entity_mention does not match', async () => {
    const { markDoneCalls } = buildMocks({
      entities: [{
        mention: 'Jessop', normalized: 'Jessop', entity_type: 'person',
        span_start: 0, span_end: 6, confidence: 0.9, genericity: 'specific'
      }],
      dates: [{
        label: '1872', mention: '1872', entity_mention: 'Nobody', earliest: '1872', latest: '1872',
        precision: 'year', span_start: 26, span_end: 30, confidence: 0.9
      }],
      relationships: []
    });

    const { runExtractionWorkerCycle } = require('../../utils/worker-extraction');
    await runExtractionWorkerCycle();

    expect(markDoneCalls).toHaveLength(1);
    expect(markDoneCalls[0].unresolved_date_count).toBe(1);
  });
});
