'use strict';

describe('resolveEntityInScope within extraction', () => {
  it('does not resolve entities across document boundaries', async () => {
    const { resolveEntityInScope } = require('../../utils/entity-resolution');

    const emptyScope = new Map();
    // Simulate a name that would have matched in the old global DB search
    const result = resolveEntityInScope('Alice Reed', 'Alice Reed', 'person', emptyScope);
    expect(result).toBeNull(); // empty scope → always creates new entity
  });

  it('resolveEntityInScope deduplicates within the same extraction run', () => {
    const { resolveEntityInScope } = require('../../utils/entity-resolution');
    const scope = new Map();
    scope.set('alice reed', 7);
    scope.set('alice', 7);

    const result = resolveEntityInScope('Alice Reed', 'Alice Reed', 'person', scope);
    expect(result).toEqual({ entityId: 7, matchType: 'scope_canonical' });
  });
});

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
      resolveEntityInScope: jest.fn(() => null),
      normalizeComparable: jest.fn((v) => String(v || '').toLowerCase().trim()),
      normalizeForMatching: jest.fn((v) => String(v || '').toLowerCase().trim())
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

describe('extraction batch polling', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('only finalizes a completed extraction batch after winning the durable claim', async () => {
    const appendLog = jest.fn(async () => {});
    const updateBatchProgress = jest.fn(async () => {});
    const savePartialResults = jest.fn(async () => {});
    const claimBatchFinalization = jest.fn(async () => true);
    const heartbeatBatchFinalizationClaim = jest.fn(async () => true);
    const markDone = jest.fn(async () => {});
    const markFailed = jest.fn(async () => {});

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeExtractionLogger: jest.fn(() => jest.fn(async (line) => appendLog(line))),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'vertex',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));

    const extractionJobs = {
      getRunningBatches: jest.fn(async () => [{
        id: 71,
        job_kind: 'batch',
        status: 'running',
        provider: 'vertex',
        model: 'default',
        batch_remote_id: 'remote-e1',
        batch_remote_status: 'running',
        batch_manifest: JSON.stringify({
          requests: [{ customId: 'extract-7', documentId: 7, transcriptId: 5 }]
        }),
        batch_completed_count: 0,
        batch_failed_count: 0,
        entity_count: 0,
        relationship_count: 0
      }]),
      appendLog,
      updateBatchProgress,
      savePartialResults,
      getPartialResults: jest.fn(async () => []),
      claimBatchFinalization,
      heartbeatBatchFinalizationClaim,
      markDone,
      markFailed
    };

    jest.doMock('../../database/db', () => ({
      extractionJobs,
      transcriptsAsync: {
        getById: jest.fn(async () => ({ id: 5, content: 'Alice met Bob in Boston.' }))
      },
      documentsAsync: {
        getById: jest.fn(async () => ({ id: 7, metadata: {} }))
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
      }
    }));
    jest.doMock('../../utils/extraction-batches', () => ({
      pollExtractionBatch: jest.fn(async () => ({
        state: 'completed',
        remoteStatus: 'completed',
        completedCount: 1,
        failedCount: 0,
        itemResults: [{
          customId: 'extract-7',
          ok: true,
          result: {
            entities: [],
            relationships: [],
            dates: [],
            paradata: {}
          }
        }]
      })),
      parseBatchManifest: jest.fn(() => [{ customId: 'extract-7', documentId: 7, transcriptId: 5 }])
    }));
    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntityInScope: jest.fn(() => null),
      normalizeComparable: jest.fn((v) => String(v || '').toLowerCase().trim()),
      normalizeForMatching: jest.fn((v) => String(v || '').toLowerCase().trim())
    }));

    const worker = require('../../utils/worker-extraction');
    await worker.pollRunningExtractionBatches();

    expect(claimBatchFinalization).toHaveBeenCalledWith(71, expect.stringMatching(/^pid:/), expect.any(Number));
    expect(heartbeatBatchFinalizationClaim).toHaveBeenCalledWith(71, expect.stringMatching(/^pid:/));
    expect(savePartialResults).toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(71, {
      entity_count: 0,
      relationship_count: 0
    });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('skips extraction finalization when another worker already holds the durable claim', async () => {
    const appendLog = jest.fn(async () => {});
    const updateBatchProgress = jest.fn(async () => {});
    const savePartialResults = jest.fn(async () => {});
    const claimBatchFinalization = jest.fn(async () => false);
    const markDone = jest.fn(async () => {});
    const markFailed = jest.fn(async () => {});

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeExtractionLogger: jest.fn(() => jest.fn(async (line) => appendLog(line))),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'vertex',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));

    const extractionJobs = {
      getRunningBatches: jest.fn(async () => [{
        id: 72,
        job_kind: 'batch',
        status: 'running',
        provider: 'vertex',
        model: 'default',
        batch_remote_id: 'remote-e2',
        batch_remote_status: 'running',
        batch_manifest: JSON.stringify({
          requests: [{ customId: 'extract-8', documentId: 8, transcriptId: 6 }]
        }),
        batch_completed_count: 0,
        batch_failed_count: 0,
        entity_count: 0,
        relationship_count: 0
      }]),
      appendLog,
      updateBatchProgress,
      savePartialResults,
      getPartialResults: jest.fn(async () => []),
      claimBatchFinalization,
      heartbeatBatchFinalizationClaim: jest.fn(async () => true),
      markDone,
      markFailed
    };

    jest.doMock('../../database/db', () => ({
      extractionJobs,
      transcriptsAsync: {
        getById: jest.fn(async () => ({ id: 6, content: 'Alice met Bob in Boston.' }))
      },
      documentsAsync: {
        getById: jest.fn(async () => ({ id: 8, metadata: {} }))
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
      }
    }));
    jest.doMock('../../utils/extraction-batches', () => ({
      pollExtractionBatch: jest.fn(async () => ({
        state: 'completed',
        remoteStatus: 'completed',
        completedCount: 1,
        failedCount: 0,
        itemResults: [{
          customId: 'extract-8',
          ok: true,
          result: {
            entities: [],
            relationships: [],
            dates: [],
            paradata: {}
          }
        }]
      })),
      parseBatchManifest: jest.fn(() => [{ customId: 'extract-8', documentId: 8, transcriptId: 6 }])
    }));
    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntityInScope: jest.fn(() => null),
      normalizeComparable: jest.fn((v) => String(v || '').toLowerCase().trim()),
      normalizeForMatching: jest.fn((v) => String(v || '').toLowerCase().trim())
    }));

    const worker = require('../../utils/worker-extraction');
    await worker.pollRunningExtractionBatches();

    expect(claimBatchFinalization).toHaveBeenCalled();
    expect(savePartialResults).not.toHaveBeenCalled();
    expect(markDone).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });
});
