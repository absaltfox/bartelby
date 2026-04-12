'use strict';

describe('extraction worker cycle', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadModule({ job, extractionImpl, transient = false }) {
    const logLine = jest.fn(async () => {});
    const markDone = jest.fn(async () => {});
    const requeueForRetry = jest.fn(async () => {});
    const markFailed = jest.fn(async () => {});
    const appendLog = jest.fn(async () => {});

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => transient),
      sleep: jest.fn(async () => {}),
      makeExtractionLogger: jest.fn(() => logLine),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'openai',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));

    const extractionJobs = {
      claimNextQueued: jest.fn(async () => job),
      appendLog,
      markDone,
      requeueForRetry,
      markFailed,
      updateBatchRemote: jest.fn(async () => {}),
      updateBatchProgress: jest.fn(async () => {})
    };

    jest.doMock('../../database/db', () => ({
      extractionJobs,
      transcriptsAsync: {
        getById: jest.fn(async () => ({
          id: 5,
          content: 'Alice met Bob in Boston on January 1, 1900.'
        }))
      },
      documentsAsync: {
        getById: jest.fn(async () => ({
          id: 7,
          metadata: {}
        }))
      },
      entities: {
        create: jest.fn(async () => 1)
      },
      entityAliases: {
        createIfMissing: jest.fn(async () => {})
      },
      dateExpressions: {
        createIfMissing: jest.fn(async () => {})
      },
      relationships: {
        findExisting: jest.fn(async () => null),
        create: jest.fn(async () => 2)
      },
      citations: {
        create: jest.fn(async () => {})
      },
      relationshipTypes: {
        resolve: jest.fn(async () => 'related_to'),
        create: jest.fn(async () => {})
      },
      graphMaintenance: {
        resetTranscriptExtraction: jest.fn(async () => ({
          deletedCitations: 0,
          deletedRelationships: 0,
          deletedEntities: 0
        }))
      },
      userApiKeysAsync: {
        markUsed: jest.fn(async () => {})
      }
    }));

    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: jest.fn(extractionImpl)
    }));
    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntity: jest.fn(async () => null)
    }));

    const worker = require('../../utils/worker-extraction');
    return { worker, extractionJobs, markDone, requeueForRetry, markFailed };
  }

  it('marks a successful extraction job done', async () => {
    const { worker, markDone, requeueForRetry, markFailed } = loadModule({
      job: {
        id: 21,
        attempts: 0,
        document_id: 7,
        transcript_id: 5,
        job_kind: 'single',
        provider_key_scope: null,
        reset_existing: 0
      },
      extractionImpl: async () => ({
        entities: [],
        relationships: [],
        dates: [],
        paradata: { model: 'gpt-test' }
      })
    });

    await worker.runExtractionWorkerCycle();

    expect(markDone).toHaveBeenCalledWith(21, {
      entity_count: 0,
      relationship_count: 0
    });
    expect(requeueForRetry).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('requeues transient extraction failures', async () => {
    const { worker, requeueForRetry, markFailed } = loadModule({
      job: {
        id: 22,
        attempts: 0,
        document_id: 7,
        transcript_id: 5,
        job_kind: 'single',
        provider_key_scope: null,
        reset_existing: 0
      },
      transient: true,
      extractionImpl: async () => {
        throw new Error('503 overloaded');
      }
    });

    await worker.runExtractionWorkerCycle();

    expect(requeueForRetry).toHaveBeenCalledWith(22);
    expect(markFailed).not.toHaveBeenCalled();
  });
});
