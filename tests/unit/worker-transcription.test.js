'use strict';

describe('transcription worker cycle', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadModule({ job, transcribeImpl, transient = false }) {
    const logLine = jest.fn(async () => {});
    const appendLog = jest.fn(async () => {});
    const savePartialResults = jest.fn(async () => {});
    const clearPartialResults = jest.fn(async () => {});
    const markDone = jest.fn(async () => {});
    const requeueForRetry = jest.fn(async () => {});
    const markFailed = jest.fn(async () => {});
    const getPartialResults = jest.fn(async () => []);
    const readUploadByUrl = jest.fn(async () => Buffer.from('image-buffer'));
    const persistDocumentTranscription = jest.fn(async () => ({
      combined: { paradata: { run_duration_ms: 250 } }
    }));
    const transcribeDocument = jest.fn(transcribeImpl);

    jest.doMock('../../utils/storage', () => ({
      readUploadByUrl
    }));
    jest.doMock('../../utils/mime-types', () => ({
      mimeTypeFromFilename: jest.fn(() => 'image/png')
    }));
    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => transient),
      sleep: jest.fn(async () => {}),
      makeJobLogger: jest.fn(() => logLine),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'openai',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));
    jest.doMock('../../database/db', () => ({
      transcriptionJobsAsync: {
        claimNextQueued: jest.fn(async () => job),
        appendLog,
        getPartialResults,
        savePartialResults,
        clearPartialResults,
        markDone,
        requeueForRetry,
        markFailed
      },
      userApiKeysAsync: {
        markUsed: jest.fn(async () => {})
      }
    }));
    jest.doMock('../../utils/llm', () => ({
      createProvider: jest.fn(async () => ({
        transcribeDocument
      }))
    }));
    jest.doMock('../../utils/transcription-pipeline', () => ({
      persistDocumentTranscription
    }));

    const worker = require('../../utils/worker-transcription');

    return {
      worker,
      logLine,
      savePartialResults,
      clearPartialResults,
      markDone,
      requeueForRetry,
      markFailed,
      readUploadByUrl,
      persistDocumentTranscription,
      transcribeDocument
    };
  }

  it('processes a queued transcription job and marks it done', async () => {
    const job = {
      id: 11,
      attempts: 0,
      document_id: 42,
      image_path: '/uploads/page1.png',
      additional_image_paths: JSON.stringify(['/uploads/page2.png']),
      provider_key_scope: null,
      user_api_key_id: null,
      requested_by_user_id: null
    };

    const {
      worker,
      savePartialResults,
      clearPartialResults,
      markDone,
      requeueForRetry,
      markFailed,
      readUploadByUrl,
      persistDocumentTranscription,
      transcribeDocument
    } = loadModule({
      job,
      transcribeImpl: async () => ({
        transcription: 'page text',
        notes: null,
        metadata: {},
        paradata: { run_duration_ms: 125 }
      })
    });

    await worker.runTranscriptionWorkerCycle();

    expect(readUploadByUrl).toHaveBeenCalledTimes(2);
    expect(transcribeDocument).toHaveBeenCalledTimes(2);
    expect(savePartialResults).toHaveBeenCalledTimes(2);
    expect(persistDocumentTranscription).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 42,
      results: expect.any(Array)
    }));
    expect(clearPartialResults).toHaveBeenCalledWith(11);
    expect(markDone).toHaveBeenCalledWith(11);
    expect(requeueForRetry).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('requeues transient failures instead of marking the job failed', async () => {
    const job = {
      id: 12,
      attempts: 0,
      document_id: 77,
      image_path: '/uploads/page1.png',
      provider_key_scope: null
    };

    const {
      worker,
      requeueForRetry,
      markFailed
    } = loadModule({
      job,
      transient: true,
      transcribeImpl: async () => {
        throw new Error('rate limit exceeded');
      }
    });

    await worker.runTranscriptionWorkerCycle();

    expect(requeueForRetry).toHaveBeenCalledWith(12);
    expect(markFailed).not.toHaveBeenCalled();
  });
});

describe('transcription batch polling', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('only finalizes a completed batch after winning the durable claim', async () => {
    const appendLog = jest.fn(async () => {});
    const updateBatchProgress = jest.fn(async () => {});
    const claimBatchFinalization = jest.fn(async () => true);
    const heartbeatBatchFinalizationClaim = jest.fn(async () => true);
    const markDone = jest.fn(async () => {});
    const markFailed = jest.fn(async () => {});
    const persistDocumentTranscription = jest.fn(async () => ({
      transcriptId: 3244,
      combined: { paradata: { run_duration_ms: 10 } }
    }));

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeJobLogger: jest.fn(() => jest.fn(async (line) => appendLog(line))),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'vertex',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));
    jest.doMock('../../database/db', () => ({
      transcriptionJobsAsync: {
        getRunningBatches: jest.fn(async () => [{
          id: 55,
          job_kind: 'batch',
          status: 'running',
          provider: 'vertex',
          model: 'default',
          batch_remote_id: 'remote-1',
          batch_remote_status: 'running',
          batch_manifest: JSON.stringify({
            requests: [{ customId: 'doc-7-page-1', documentId: 7, pageIndex: 0 }]
          })
        }]),
        appendLog,
        updateBatchProgress,
        claimBatchFinalization,
        heartbeatBatchFinalizationClaim,
        getPartialResults: jest.fn(async () => []),
        savePartialResults: jest.fn(async () => {}),
        clearPartialResults: jest.fn(async () => {}),
        markDone,
        markFailed
      },
      extractionJobsAsync: {
        create: jest.fn(async () => 1),
        createBatch: jest.fn(async () => 1)
      }
    }));
    jest.doMock('../../utils/extraction-batches', () => ({
      supportsExtractionBatchProvider: jest.fn(() => false)
    }));
    jest.doMock('../../utils/transcription-batches', () => ({
      pollTranscriptionBatch: jest.fn(async () => ({
        state: 'completed',
        remoteStatus: 'completed',
        completedCount: 1,
        failedCount: 0,
        pageResults: [{
          customId: 'doc-7-page-1',
          ok: true,
          result: { transcription: 'page text', metadata: {}, notes: null, paradata: {} }
        }]
      })),
      parseBatchManifest: jest.fn(() => [{ customId: 'doc-7-page-1', documentId: 7, pageIndex: 0 }])
    }));
    jest.doMock('../../utils/transcription-pipeline', () => ({
      persistDocumentTranscription
    }));

    const worker = require('../../utils/worker-transcription');
    await worker.pollRunningTranscriptionBatches();

    expect(claimBatchFinalization).toHaveBeenCalledWith(55, expect.stringMatching(/^transcription-finalization:/), expect.any(Number));
    expect(heartbeatBatchFinalizationClaim).toHaveBeenCalledWith(55, expect.stringMatching(/^transcription-finalization:/));
    expect(persistDocumentTranscription).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 7
    }));
    expect(markDone).toHaveBeenCalledWith(55);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('skips finalization when another worker already holds the durable claim', async () => {
    const appendLog = jest.fn(async () => {});
    const updateBatchProgress = jest.fn(async () => {});
    const claimBatchFinalization = jest.fn(async () => false);
    const persistDocumentTranscription = jest.fn(async () => ({
      transcriptId: 999,
      combined: { paradata: { run_duration_ms: 10 } }
    }));

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeJobLogger: jest.fn(() => jest.fn(async (line) => appendLog(line))),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'vertex',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));
    jest.doMock('../../database/db', () => ({
      transcriptionJobsAsync: {
        getRunningBatches: jest.fn(async () => [{
          id: 56,
          job_kind: 'batch',
          status: 'running',
          provider: 'vertex',
          model: 'default',
          batch_remote_id: 'remote-2',
          batch_remote_status: 'running',
          batch_manifest: JSON.stringify({
            requests: [{ customId: 'doc-8-page-1', documentId: 8, pageIndex: 0 }]
          })
        }]),
        appendLog,
        updateBatchProgress,
        claimBatchFinalization,
        heartbeatBatchFinalizationClaim: jest.fn(async () => true),
        getPartialResults: jest.fn(async () => []),
        savePartialResults: jest.fn(async () => {}),
        clearPartialResults: jest.fn(async () => {}),
        markDone: jest.fn(async () => {}),
        markFailed: jest.fn(async () => {})
      }
    }));
    jest.doMock('../../utils/transcription-batches', () => ({
      pollTranscriptionBatch: jest.fn(async () => ({
        state: 'completed',
        remoteStatus: 'completed',
        completedCount: 1,
        failedCount: 0,
        pageResults: [{
          customId: 'doc-8-page-1',
          ok: true,
          result: { transcription: 'page text', metadata: {}, notes: null, paradata: {} }
        }]
      })),
      parseBatchManifest: jest.fn(() => [{ customId: 'doc-8-page-1', documentId: 8, pageIndex: 0 }])
    }));
    jest.doMock('../../utils/transcription-pipeline', () => ({
      persistDocumentTranscription
    }));

    const worker = require('../../utils/worker-transcription');
    await worker.pollRunningTranscriptionBatches();

    expect(claimBatchFinalization).toHaveBeenCalled();
    expect(persistDocumentTranscription).not.toHaveBeenCalled();
  });

  it('does not fail the job when another worker takes over transcription finalization', async () => {
    const appendLog = jest.fn(async () => {});
    const claimBatchFinalization = jest.fn(async () => true);
    const persistDocumentTranscription = jest.fn(async () => ({
      transcriptId: 999,
      combined: { paradata: { run_duration_ms: 10 } }
    }));

    jest.doMock('../../utils/worker-runtime', () => ({
      MAX_RETRIES: 3,
      COOLDOWN_MS: 0,
      isTransientError: jest.fn(() => false),
      sleep: jest.fn(async () => {}),
      makeJobLogger: jest.fn(() => jest.fn(async (line) => appendLog(line))),
      resolveRuntimeConfig: jest.fn(async () => ({
        providerName: 'vertex',
        temperature: 0.2,
        runtimeConfig: {}
      }))
    }));
    jest.doMock('../../database/db', () => ({
      transcriptionJobsAsync: {
        getRunningBatches: jest.fn(async () => [{
          id: 57,
          job_kind: 'batch',
          status: 'running',
          provider: 'vertex',
          model: 'default',
          batch_remote_id: 'remote-3',
          batch_remote_status: 'running',
          batch_manifest: JSON.stringify({
            requests: [{ customId: 'doc-9-page-1', documentId: 9, pageIndex: 0 }]
          })
        }]),
        appendLog,
        updateBatchProgress: jest.fn(async () => {}),
        claimBatchFinalization,
        heartbeatBatchFinalizationClaim: jest.fn(async () => false),
        getPartialResults: jest.fn(async () => []),
        savePartialResults: jest.fn(async () => {}),
        clearPartialResults: jest.fn(async () => {}),
        markDone: jest.fn(async () => {}),
        markFailed: jest.fn(async () => {})
      }
    }));
    jest.doMock('../../utils/transcription-batches', () => ({
      pollTranscriptionBatch: jest.fn(async () => ({
        state: 'completed',
        remoteStatus: 'completed',
        completedCount: 1,
        failedCount: 0,
        pageResults: [{
          customId: 'doc-9-page-1',
          ok: true,
          result: { transcription: 'page text', metadata: {}, notes: null, paradata: {} }
        }]
      })),
      parseBatchManifest: jest.fn(() => [{ customId: 'doc-9-page-1', documentId: 9, pageIndex: 0 }])
    }));
    jest.doMock('../../utils/transcription-pipeline', () => ({
      persistDocumentTranscription
    }));

    const worker = require('../../utils/worker-transcription');
    await worker.pollRunningTranscriptionBatches();

    expect(claimBatchFinalization).toHaveBeenCalled();
    expect(persistDocumentTranscription).not.toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith(expect.stringContaining('WARN: Lost finalization claim'));
  });
});
