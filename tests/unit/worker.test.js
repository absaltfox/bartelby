'use strict';

describe('background worker grouping jobs', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('passes the requesting user id into queued grouping execution', async () => {
    const markDone = jest.fn(async () => {});
    const markFailed = jest.fn(async () => {});
    const runDocumentGrouping = jest.fn(async () => ({
      groups: [{ pageIndices: [0, 1], label: 'Doc 1' }]
    }));

    jest.doMock('../../database/db', () => ({
      importJobsAsync: {
        claimNextQueuedGrouping: jest.fn(async () => ({
          id: 91,
          user_id: 7,
          submit_payload: JSON.stringify({
            provider: 'openai',
            tempFiles: ['page-1.png', 'page-2.png'],
            credentialSource: 'user:12'
          })
        })),
        markDone,
        markFailed
      }
    }));
    jest.doMock('../../utils/grouping-llm', () => ({
      runDocumentGrouping
    }));

    const worker = require('../../utils/worker');
    await worker.__testables.tickGroupingJobs();

    expect(runDocumentGrouping).toHaveBeenCalledWith(
      'openai',
      ['page-1.png', 'page-2.png'],
      'user:12',
      7
    );
    expect(markDone).toHaveBeenCalledWith(91, [{ pageIndices: [0, 1], label: 'Doc 1' }]);
    expect(markFailed).not.toHaveBeenCalled();
  });
});
