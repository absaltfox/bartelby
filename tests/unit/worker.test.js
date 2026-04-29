'use strict';

describe('background worker grouping jobs', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('passes the requesting user id into queued grouping execution', async () => {
    const markDone = jest.fn(async () => {});
    const markFailed = jest.fn(async () => {});
    const updateGroupingState = jest.fn(async () => {});
    const promoteQueuedTempAssets = jest.fn(async () => ['durable-1.png', 'durable-2.png']);
    const runDocumentGrouping = jest.fn(async () => ({
      groups: [{ pageIndices: [0, 1], label: 'Doc 1', confidence: 'high' }]
    }));

    jest.doMock('../../database/db', () => ({
      importJobsAsync: {
        claimNextQueuedGrouping: jest.fn(async () => ({
          id: 91,
          user_id: 7,
          submit_payload: JSON.stringify({
            provider: 'openai',
            tempFiles: ['page-1.png', 'page-2.png'],
            credentialSource: 'user:12',
            sourceImportJobId: 12,
            collectionIds: [4]
          })
        })),
        markDone,
        markFailed,
        updateGroupingState
      }
    }));
    jest.doMock('../../utils/temp-assets', () => ({
      promoteQueuedTempAssets
    }));
    jest.doMock('../../utils/grouping-batches', () => ({
      buildGroupingManifest: jest.fn(),
      resolveGroupingRuntime: jest.fn(async () => ({ provider: 'openai' })),
      submitGroupingBatch: jest.fn()
    }));
    jest.doMock('../../utils/transcription-batches', () => ({
      supportsBatchProvider: jest.fn(() => false)
    }));
    jest.doMock('../../utils/grouping-llm', () => ({
      runDocumentGrouping
    }));

    const worker = require('../../utils/worker');
    await worker.__testables.tickGroupingJobs();

    expect(promoteQueuedTempAssets).toHaveBeenCalledWith(['page-1.png', 'page-2.png']);
    expect(runDocumentGrouping).toHaveBeenCalledWith(
      'openai',
      ['durable-1.png', 'durable-2.png'],
      'user:12',
      7,
      expect.objectContaining({
        cropRegion: 'top',
        onProgress: expect.any(Function)
      })
    );
    expect(markDone).toHaveBeenCalledWith(91, [{ pageIndices: [0, 1], label: 'Doc 1', confidence: 'high' }]);
    expect(updateGroupingState).toHaveBeenCalledWith(12, {
      collectionIds: [4],
      groups: [{
        label: 'Doc 1',
        source: 'ai',
        confidence: 'high',
        pages: ['durable-1.png', 'durable-2.png']
      }]
    });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('retries synchronous grouping with the fallback crop region after an empty result', async () => {
    const markDone = jest.fn(async () => {});
    const promoteQueuedTempAssets = jest.fn(async () => ['durable-1.png', 'durable-2.png']);
    const runDocumentGrouping = jest
      .fn()
      .mockResolvedValueOnce({ groups: [] })
      .mockResolvedValueOnce({
        groups: [{ pageIndices: [0, 1], label: 'Doc 1', confidence: 'medium' }]
      });

    jest.doMock('../../database/db', () => ({
      importJobsAsync: {
        claimNextQueuedGrouping: jest.fn(async () => ({
          id: 92,
          user_id: 7,
          submit_payload: JSON.stringify({
            provider: 'openai',
            tempFiles: ['page-1.png', 'page-2.png'],
            credentialSource: 'user:12',
            cropRegion: 'top',
            fallbackCropRegion: 'bottom'
          })
        })),
        markDone,
        markFailed: jest.fn(async () => {})
      }
    }));
    jest.doMock('../../utils/temp-assets', () => ({
      promoteQueuedTempAssets
    }));
    jest.doMock('../../utils/grouping-batches', () => ({
      buildGroupingManifest: jest.fn(),
      resolveGroupingRuntime: jest.fn(async () => ({ provider: 'openai' })),
      submitGroupingBatch: jest.fn()
    }));
    jest.doMock('../../utils/transcription-batches', () => ({
      supportsBatchProvider: jest.fn(() => false)
    }));
    jest.doMock('../../utils/grouping-llm', () => ({
      runDocumentGrouping
    }));

    const worker = require('../../utils/worker');
    await worker.__testables.tickGroupingJobs();

    expect(runDocumentGrouping).toHaveBeenNthCalledWith(
      1,
      'openai',
      ['durable-1.png', 'durable-2.png'],
      'user:12',
      7,
      expect.objectContaining({ cropRegion: 'top' })
    );
    expect(runDocumentGrouping).toHaveBeenNthCalledWith(
      2,
      'openai',
      ['durable-1.png', 'durable-2.png'],
      'user:12',
      7,
      expect.objectContaining({ cropRegion: 'bottom' })
    );
    expect(markDone).toHaveBeenCalledWith(92, [{ pageIndices: [0, 1], label: 'Doc 1', confidence: 'medium' }]);
  });

  it('does not claim a second local PDF render job while one is still running', async () => {
    const claimNextQueuedRender = jest
      .fn()
      .mockResolvedValueOnce({
        id: 51,
        file_path: 'first.pdf',
        original_name: 'first.pdf'
      })
      .mockResolvedValueOnce({
        id: 52,
        file_path: 'second.pdf',
        original_name: 'second.pdf'
      });
    const updateProgress = jest.fn(async () => {});
    const markDone = jest.fn(async () => {});
    let renderCallbacks = null;

    jest.doMock('../../config', () => ({
      flyMachines: { enabled: false },
      storage: { driver: 'local' }
    }));
    jest.doMock('../../database/db', () => ({
      importJobsAsync: {
        claimNextQueuedGrouping: jest.fn(async () => null),
        claimNextQueuedRender,
        updateProgress,
        markDone,
        markFailed: jest.fn(async () => {}),
        updateMachineId: jest.fn(async () => {}),
        getAll: jest.fn(async () => [])
      },
      mfaRememberTokensAsync: {
        deleteExpired: jest.fn(async () => {})
      }
    }));
    jest.doMock('../../utils/storage', () => ({
      deleteTempFile: jest.fn()
    }));
    jest.doMock('../../utils/import-workflow', () => ({
      spawnLocalPdfWorker: jest.fn((callbacks) => {
        renderCallbacks = callbacks;
      })
    }));

    const worker = require('../../utils/worker');
    const firstTick = worker.__testables.tickImportRenderJobs();
    await Promise.resolve();
    const secondTick = worker.__testables.tickImportRenderJobs();

    expect(claimNextQueuedRender).toHaveBeenCalledTimes(1);
    expect(renderCallbacks).toBeTruthy();

    renderCallbacks.onDone({ pages: [{ filename: 'page-1.png' }] });
    await firstTick;
    await secondTick;

    expect(markDone).toHaveBeenCalledWith(51, [{ filename: 'page-1.png' }]);
    expect(claimNextQueuedRender).toHaveBeenCalledTimes(1);
  });
});
