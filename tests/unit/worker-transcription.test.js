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
