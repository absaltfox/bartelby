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
      relationshipTypeAliasesAsync: {
        resolve: jest.fn(async () => null)
      },
      graphMaintenance: {
        resetTranscriptExtraction: jest.fn(async () => ({
          deletedCitations: 0,
          deletedRelationships: 0,
          deletedEntities: 0
        }))
      },
      authorityGenericTermsAsync: { listActive: jest.fn(async () => []) },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: jest.fn(async () => true), create: jest.fn(async () => {}) },
      documentCollectionsAsync: { getByDocumentId: jest.fn(async () => []) },
      getAsync: jest.fn(async () => null),
      sentimentAsync: { hasQueuedOrRunningForTranscript: jest.fn(async () => true), createJob: jest.fn(async () => {}) },
      userApiKeysAsync: {
        markUsed: jest.fn(async () => {})
      }
    }));

    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: jest.fn(extractionImpl)
    }));
    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntityInScope: jest.fn(() => null),
      resolveMentionToEntity: jest.fn((mention, scope) => {
        const key = String(mention || '').toLowerCase().trim();
        return scope.get(key) || null;
      }),
      seedMentionLookup: jest.fn(({ mention, normalized, entityId, mentionToEntityId }) => {
        if (mention) mentionToEntityId.set(String(mention).toLowerCase().trim(), entityId);
        if (normalized) mentionToEntityId.set(String(normalized).toLowerCase().trim(), entityId);
      }),
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

    expect(markDone).toHaveBeenCalledWith(21, expect.objectContaining({
      entity_count: 0,
      relationship_count: 0,
      unresolved_relationship_count: 0,
      unresolved_date_count: 0,
      dropped_verbatim_mismatch_count: 0,
      dropped_unknown_entity_mention_count: 0
    }));
    expect(requeueForRetry).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('drops relationship evidence that is not anchored in the transcript', async () => {
    const { worker, markDone } = loadModule({
      job: {
        id: 24,
        attempts: 0,
        document_id: 7,
        transcript_id: 5,
        job_kind: 'single',
        provider_key_scope: null,
        reset_existing: 0
      },
      extractionImpl: async () => ({
        entities: [
          { mention: 'Alice', normalized: 'Alice', entity_type: 'person', span_start: 0, span_end: 5, confidence: 0.9 },
          { mention: 'Bob', normalized: 'Bob', entity_type: 'person', span_start: 10, span_end: 13, confidence: 0.9 }
        ],
        relationships: [{
          source_mention: 'Alice',
          target_mention: 'Bob',
          type: 'related_to',
          evidence_text: 'Alice invented this sentence about Bob',
          confidence: 0.9
        }],
        dates: [],
        paradata: { model: 'gpt-test' }
      })
    });

    await worker.runExtractionWorkerCycle();

    expect(markDone).toHaveBeenCalledWith(24, expect.objectContaining({
      relationship_count: 0,
      dropped_verbatim_mismatch_count: 1,
      dropped_unknown_entity_mention_count: 0
    }));
  });

  it('counts relationship mentions that cannot be resolved to extracted entities', async () => {
    const { worker, markDone } = loadModule({
      job: {
        id: 25,
        attempts: 0,
        document_id: 7,
        transcript_id: 5,
        job_kind: 'single',
        provider_key_scope: null,
        reset_existing: 0
      },
      extractionImpl: async () => ({
        entities: [
          { mention: 'Alice', normalized: 'Alice', entity_type: 'person', span_start: 0, span_end: 5, confidence: 0.9 }
        ],
        relationships: [{
          source_mention: 'Alice',
          target_mention: 'Charlie',
          type: 'related_to',
          evidence_text: 'Alice met Bob',
          confidence: 0.9
        }],
        dates: [],
        paradata: { model: 'gpt-test' }
      })
    });

    await worker.runExtractionWorkerCycle();

    expect(markDone).toHaveBeenCalledWith(25, expect.objectContaining({
      relationship_count: 0,
      unresolved_relationship_count: 1,
      dropped_unknown_entity_mention_count: 1,
      dropped_verbatim_mismatch_count: 0
    }));
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

describe('extraction worker cycle - attempt logging', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('logs 1-based attempt number for batch extraction submission', async () => {
    const logLine = jest.fn(async () => {});

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeExtractionLogger: jest.fn(() => logLine),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'openai',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));

    jest.doMock('../../database/db', () => ({
      extractionJobs: {
        claimNextQueued: jest.fn(async () => ({
          id: 100,
          attempts: 0,
          job_kind: 'batch',
          batch_document_count: 3,
          provider_key_scope: null
        })),
        updateBatchRemote: jest.fn(async () => {}),
        markFailed: jest.fn(async () => {})
      },
      userApiKeysAsync: { markUsed: jest.fn(async () => {}) }
    }));

    jest.doMock('../../utils/extraction-batches', () => ({
      submitExtractionBatch: jest.fn(async () => ({ remoteId: 'remote-1', remoteStatus: 'running' }))
    }));

    const worker = require('../../utils/worker-extraction');
    await worker.runExtractionWorkerCycle();

    expect(logLine.mock.calls[0][0]).toContain('attempt 1');
  });

  it('logs 1-based attempt number for single extraction', async () => {
    const logLine = jest.fn(async () => {});

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeExtractionLogger: jest.fn(() => logLine),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'openai',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));

    jest.doMock('../../database/db', () => ({
      extractionJobs: {
        claimNextQueued: jest.fn(async () => ({
          id: 101,
          attempts: 0,
          job_kind: 'single',
          document_id: 7,
          transcript_id: 5,
          provider_key_scope: null,
          reset_existing: 0
        })),
        markDone: jest.fn(async () => {}),
        markFailed: jest.fn(async () => {})
      },
      transcriptsAsync: { getById: jest.fn(async () => ({ id: 5, content: 'test content' })) },
      documentsAsync: { getById: jest.fn(async () => ({ id: 7, metadata: {} })) },
      entities: { create: jest.fn(async () => 1) },
      entityAliases: { createIfMissing: jest.fn(async () => {}) },
      dateExpressions: { createIfMissing: jest.fn(async () => {}) },
      relationships: { findExisting: jest.fn(async () => null), create: jest.fn(async () => 2) },
      citations: { create: jest.fn(async () => {}) },
      relationshipTypes: { resolve: jest.fn(async () => 'related_to'), create: jest.fn(async () => {}) },
      graphMaintenance: { resetTranscriptExtraction: jest.fn(async () => ({ deletedCitations: 0, deletedRelationships: 0, deletedEntities: 0 })) },
      documentCollectionsAsync: { getByDocumentId: jest.fn(async () => []) },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: jest.fn(async () => true), create: jest.fn(async () => {}) }
    }));

    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: jest.fn(async () => ({ entities: [], relationships: [], dates: [], paradata: {} }))
    }));
    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntityInScope: jest.fn(() => null),
      normalizeComparable: jest.fn((v) => String(v || '').toLowerCase().trim()),
      normalizeForMatching: jest.fn((v) => String(v || '').toLowerCase().trim())
    }));

    const worker = require('../../utils/worker-extraction');
    await worker.runExtractionWorkerCycle();

    expect(logLine.mock.calls[0][0]).toContain('attempt 1');
  });

  it('queues a per-collection authority suggestion job after a single extraction completes', async () => {
    const authoritySuggestionCreate = jest.fn(async () => {});
    const hasPendingOrRunning = jest.fn(async () => false);
    // Real shape: documentCollectionsAsync.getByDocumentId returns `collections.*`,
    // so the collection's primary key is `id`.
    const getByDocumentId = jest.fn(async () => [{ id: 42, name: 'Letters' }]);

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeExtractionLogger: jest.fn(() => jest.fn(async () => {})),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'openai',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));

    jest.doMock('../../database/db', () => ({
      extractionJobs: {
        claimNextQueued: jest.fn(async () => ({
          id: 200,
          attempts: 0,
          job_kind: 'single',
          document_id: 7,
          transcript_id: 5,
          provider_key_scope: null,
          reset_existing: 0
        })),
        markDone: jest.fn(async () => {}),
        markFailed: jest.fn(async () => {})
      },
      transcriptsAsync: { getById: jest.fn(async () => ({ id: 5, content: 'test content' })) },
      documentsAsync: { getById: jest.fn(async () => ({ id: 7, metadata: {} })) },
      entities: { create: jest.fn(async () => 1) },
      entityAliases: { createIfMissing: jest.fn(async () => {}) },
      dateExpressions: { createIfMissing: jest.fn(async () => {}) },
      relationships: { findExisting: jest.fn(async () => null), create: jest.fn(async () => 2) },
      citations: { create: jest.fn(async () => {}) },
      relationshipTypes: { resolve: jest.fn(async () => 'related_to'), create: jest.fn(async () => {}) },
      graphMaintenance: { resetTranscriptExtraction: jest.fn(async () => ({ deletedCitations: 0, deletedRelationships: 0, deletedEntities: 0 })) },
      documentCollectionsAsync: { getByDocumentId },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: hasPendingOrRunning, create: authoritySuggestionCreate }
    }));

    jest.doMock('../../utils/extraction-llm', () => ({
      runExtraction: jest.fn(async () => ({ entities: [], relationships: [], dates: [], paradata: {} }))
    }));
    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntityInScope: jest.fn(() => null),
      normalizeComparable: jest.fn((v) => String(v || '').toLowerCase().trim()),
      normalizeForMatching: jest.fn((v) => String(v || '').toLowerCase().trim())
    }));

    const worker = require('../../utils/worker-extraction');
    await worker.runExtractionWorkerCycle();

    expect(getByDocumentId).toHaveBeenCalledWith(7);
    expect(hasPendingOrRunning).toHaveBeenCalledWith(42);
    expect(authoritySuggestionCreate).toHaveBeenCalledWith({ collection_id: 42 });
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

    expect(claimBatchFinalization).toHaveBeenCalledWith(71, expect.stringMatching(/^extraction-finalization:/), expect.any(Number));
    expect(heartbeatBatchFinalizationClaim).toHaveBeenCalledWith(71, expect.stringMatching(/^extraction-finalization:/));
    expect(savePartialResults).toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(71, expect.objectContaining({
      entity_count: 0,
      relationship_count: 0,
      unresolved_relationship_count: 0,
      unresolved_date_count: 0,
      dropped_verbatim_mismatch_count: 0,
      dropped_unknown_entity_mention_count: 0
    }));
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

  it('does not fail the job when another worker takes over finalization mid-stream', async () => {
    const appendLog = jest.fn(async () => {});
    const claimBatchFinalization = jest.fn(async () => true);
    const heartbeatBatchFinalizationClaim = jest.fn(async () => false);
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

    jest.doMock('../../database/db', () => ({
      extractionJobs: {
        getRunningBatches: jest.fn(async () => [{
          id: 73,
          job_kind: 'batch',
          status: 'running',
          provider: 'vertex',
          model: 'default',
          batch_remote_id: 'remote-e3',
          batch_remote_status: 'running',
          batch_manifest: JSON.stringify({
            requests: [{ customId: 'extract-9', documentId: 9, transcriptId: 7 }]
          }),
          batch_completed_count: 0,
          batch_failed_count: 0,
          entity_count: 0,
          relationship_count: 0
        }]),
        appendLog,
        updateBatchProgress: jest.fn(async () => {}),
        savePartialResults: jest.fn(async () => {}),
        getPartialResults: jest.fn(async () => []),
        claimBatchFinalization,
        heartbeatBatchFinalizationClaim,
        markDone,
        markFailed
      },
      transcriptsAsync: {
        getById: jest.fn(async () => ({ id: 7, content: 'Alice met Bob in Boston.' }))
      },
      documentsAsync: {
        getById: jest.fn(async () => ({ id: 9, metadata: {} }))
      },
      entities: { create: jest.fn(async () => 1) },
      entityAliases: { createIfMissing: jest.fn(async () => {}) },
      dateExpressions: { createIfMissing: jest.fn(async () => {}) },
      relationships: { findExisting: jest.fn(async () => null), create: jest.fn(async () => 2) },
      citations: { create: jest.fn(async () => {}) },
      relationshipTypes: { resolve: jest.fn(async () => 'related_to'), create: jest.fn(async () => {}) },
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
          customId: 'extract-9',
          ok: true,
          result: {
            entities: [],
            relationships: [],
            dates: [],
            paradata: {}
          }
        }]
      })),
      parseBatchManifest: jest.fn(() => [{ customId: 'extract-9', documentId: 9, transcriptId: 7 }])
    }));
    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntityInScope: jest.fn(() => null),
      normalizeComparable: jest.fn((v) => String(v || '').toLowerCase().trim()),
      normalizeForMatching: jest.fn((v) => String(v || '').toLowerCase().trim())
    }));

    const worker = require('../../utils/worker-extraction');
    await worker.pollRunningExtractionBatches();

    expect(claimBatchFinalization).toHaveBeenCalled();
    expect(markDone).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith(expect.stringContaining('WARN: Lost extraction finalization claim'));
  });

  function makeBatchPollingMocks({ collectionMemberships = [], alreadyQueued = false } = {}) {
    const appendLog = jest.fn(async () => {});
    const authoritySuggestionCreate = jest.fn(async () => {});
    const hasPendingOrRunning = jest.fn(async () => alreadyQueued);
    const getByDocumentId = jest.fn(async () => collectionMemberships);

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeExtractionLogger: jest.fn(() => jest.fn(async (line) => appendLog(line))),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'openai',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));

    const extractionJobs = {
      getRunningBatches: jest.fn(async () => [{
        id: 80,
        job_kind: 'batch',
        status: 'running',
        provider: 'openai',
        model: 'default',
        batch_remote_id: 'remote-80',
        batch_remote_status: 'running',
        batch_manifest: JSON.stringify({
          requests: [{ customId: 'extract-doc-7-tx-5', documentId: 7, transcriptId: 5 }]
        }),
        batch_completed_count: 0,
        batch_failed_count: 0,
        entity_count: 0,
        relationship_count: 0
      }]),
      appendLog,
      updateBatchProgress: jest.fn(async () => {}),
      savePartialResults: jest.fn(async () => {}),
      getPartialResults: jest.fn(async () => []),
      claimBatchFinalization: jest.fn(async () => true),
      heartbeatBatchFinalizationClaim: jest.fn(async () => true),
      markDone: jest.fn(async () => {}),
      markFailed: jest.fn(async () => {})
    };

    jest.doMock('../../database/db', () => ({
      extractionJobs,
      transcriptsAsync: { getById: jest.fn(async () => ({ id: 5, content: 'Alice met Bob.' })) },
      documentsAsync: { getById: jest.fn(async () => ({ id: 7, metadata: {} })) },
      entities: { create: jest.fn(async () => 1) },
      entityAliases: { createIfMissing: jest.fn(async () => {}) },
      dateExpressions: { createIfMissing: jest.fn(async () => {}) },
      relationships: { findExisting: jest.fn(async () => null), create: jest.fn(async () => 2) },
      citations: { create: jest.fn(async () => {}) },
      relationshipTypes: { resolve: jest.fn(async () => 'related_to'), create: jest.fn(async () => {}) },
      graphMaintenance: { resetTranscriptExtraction: jest.fn(async () => ({ deletedCitations: 0, deletedRelationships: 0, deletedEntities: 0 })) },
      documentCollectionsAsync: { getByDocumentId },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: hasPendingOrRunning, create: authoritySuggestionCreate }
    }));

    jest.doMock('../../utils/extraction-batches', () => ({
      pollExtractionBatch: jest.fn(async () => ({
        state: 'completed',
        remoteStatus: 'completed',
        completedCount: 1,
        failedCount: 0,
        itemResults: [{ customId: 'extract-doc-7-tx-5', ok: true, result: { entities: [], relationships: [], dates: [], paradata: {} } }]
      })),
      parseBatchManifest: jest.fn(() => [{ customId: 'extract-doc-7-tx-5', documentId: 7, transcriptId: 5 }])
    }));

    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntityInScope: jest.fn(() => null),
      normalizeComparable: jest.fn((v) => String(v || '').toLowerCase().trim()),
      normalizeForMatching: jest.fn((v) => String(v || '').toLowerCase().trim())
    }));

    return { extractionJobs, authoritySuggestionCreate, hasPendingOrRunning, getByDocumentId };
  }

  it('queues authority suggestion jobs for collections after successful batch finalization', async () => {
    // documentCollectionsAsync.getByDocumentId returns `collections.*` rows,
    // so the collection's primary key is `id`, not `collection_id`.
    const { authoritySuggestionCreate, hasPendingOrRunning, getByDocumentId } = makeBatchPollingMocks({
      collectionMemberships: [{ id: 42, name: 'Letters' }],
      alreadyQueued: false
    });

    const worker = require('../../utils/worker-extraction');
    await worker.pollRunningExtractionBatches();

    expect(getByDocumentId).toHaveBeenCalledWith(7);
    expect(hasPendingOrRunning).toHaveBeenCalledWith(42);
    expect(authoritySuggestionCreate).toHaveBeenCalledWith({ collection_id: 42 });
  });

  it('skips authority suggestion when one is already pending for the collection', async () => {
    const { authoritySuggestionCreate } = makeBatchPollingMocks({
      collectionMemberships: [{ id: 42, name: 'Letters' }],
      alreadyQueued: true
    });

    const worker = require('../../utils/worker-extraction');
    await worker.pollRunningExtractionBatches();

    expect(authoritySuggestionCreate).not.toHaveBeenCalled();
  });

  it('queues authority suggestion once per collection across multiple documents in a batch', async () => {
    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeExtractionLogger: jest.fn(() => jest.fn(async () => {})),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'openai',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));

    const authoritySuggestionCreate = jest.fn(async () => {});
    const hasPendingOrRunning = jest.fn(async () => false);
    // Both documents belong to the same collection. getByDocumentId returns
    // `collections.*` rows, so the collection id field is `id`.
    const getByDocumentId = jest.fn(async () => [{ id: 99, name: 'Letters' }]);

    const extractionJobs = {
      getRunningBatches: jest.fn(async () => [{
        id: 81,
        job_kind: 'batch',
        status: 'running',
        provider: 'openai',
        model: 'default',
        batch_remote_id: 'remote-81',
        batch_remote_status: 'running',
        batch_manifest: JSON.stringify({
          requests: [
            { customId: 'extract-doc-7-tx-5', documentId: 7, transcriptId: 5 },
            { customId: 'extract-doc-8-tx-6', documentId: 8, transcriptId: 6 }
          ]
        }),
        batch_completed_count: 0,
        batch_failed_count: 0,
        entity_count: 0,
        relationship_count: 0
      }]),
      appendLog: jest.fn(async () => {}),
      updateBatchProgress: jest.fn(async () => {}),
      savePartialResults: jest.fn(async () => {}),
      getPartialResults: jest.fn(async () => []),
      claimBatchFinalization: jest.fn(async () => true),
      heartbeatBatchFinalizationClaim: jest.fn(async () => true),
      markDone: jest.fn(async () => {}),
      markFailed: jest.fn(async () => {})
    };

    jest.doMock('../../database/db', () => ({
      extractionJobs,
      transcriptsAsync: {
        getById: jest.fn(async (id) => ({ id, content: 'test content' }))
      },
      documentsAsync: {
        getById: jest.fn(async (id) => ({ id, metadata: {} }))
      },
      entities: { create: jest.fn(async () => 1) },
      entityAliases: { createIfMissing: jest.fn(async () => {}) },
      dateExpressions: { createIfMissing: jest.fn(async () => {}) },
      relationships: { findExisting: jest.fn(async () => null), create: jest.fn(async () => 2) },
      citations: { create: jest.fn(async () => {}) },
      relationshipTypes: { resolve: jest.fn(async () => 'related_to'), create: jest.fn(async () => {}) },
      graphMaintenance: { resetTranscriptExtraction: jest.fn(async () => ({ deletedCitations: 0, deletedRelationships: 0, deletedEntities: 0 })) },
      documentCollectionsAsync: { getByDocumentId },
      authoritySuggestionJobsAsync: { hasPendingOrRunningForCollection: hasPendingOrRunning, create: authoritySuggestionCreate }
    }));

    jest.doMock('../../utils/extraction-batches', () => ({
      pollExtractionBatch: jest.fn(async () => ({
        state: 'completed',
        remoteStatus: 'completed',
        completedCount: 2,
        failedCount: 0,
        itemResults: [
          { customId: 'extract-doc-7-tx-5', ok: true, result: { entities: [], relationships: [], dates: [], paradata: {} } },
          { customId: 'extract-doc-8-tx-6', ok: true, result: { entities: [], relationships: [], dates: [], paradata: {} } }
        ]
      })),
      parseBatchManifest: jest.fn(() => [
        { customId: 'extract-doc-7-tx-5', documentId: 7, transcriptId: 5 },
        { customId: 'extract-doc-8-tx-6', documentId: 8, transcriptId: 6 }
      ])
    }));

    jest.doMock('../../utils/entity-resolution', () => ({
      resolveEntityInScope: jest.fn(() => null),
      normalizeComparable: jest.fn((v) => String(v || '').toLowerCase().trim()),
      normalizeForMatching: jest.fn((v) => String(v || '').toLowerCase().trim())
    }));

    const worker = require('../../utils/worker-extraction');
    await worker.pollRunningExtractionBatches();

    // Both documents share collection 99 — suggestion job should only be created once
    expect(authoritySuggestionCreate).toHaveBeenCalledTimes(1);
    expect(authoritySuggestionCreate).toHaveBeenCalledWith({ collection_id: 99 });
  });
});
