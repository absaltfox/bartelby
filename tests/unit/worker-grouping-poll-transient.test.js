'use strict';

let mockRuntimeError;

jest.mock('../../database/db', () => ({
  importJobsAsync: {
    getRunningGroupingBatches: jest.fn(async () => [{
      id: 42, user_id: 1, submit_payload: '{}', batch_remote_id: 'batch-x', batch_manifest: '[]'
    }]),
    markFailed: jest.fn(),
    updateBatchStatus: jest.fn()
  }
}));
jest.mock('../../utils/grouping-batches', () => ({
  resolveGroupingRuntime: jest.fn(async () => { throw mockRuntimeError; }),
  parseGroupingBatchResults: jest.fn(),
  pollVertexGroupingBatch: jest.fn(),
  buildGroupingManifest: jest.fn(),
  submitGroupingBatch: jest.fn()
}));
jest.mock('../../utils/worker-transcription', () => ({
  runTranscriptionWorkerCycle: jest.fn(), pollRunningTranscriptionBatches: jest.fn()
}));
jest.mock('../../utils/worker-extraction', () => ({
  runExtractionWorkerCycle: jest.fn(), pollRunningExtractionBatches: jest.fn()
}));
jest.mock('../../utils/worker-authority-resolution', () => ({ runAuthorityResolutionWorkerCycle: jest.fn() }));
jest.mock('../../utils/worker-authority-suggestion', () => ({ runAuthoritySuggestionWorkerCycle: jest.fn() }));
jest.mock('../../utils/analytics', () => ({ runScheduledAnalytics: jest.fn() }));

const { __testables } = require('../../utils/worker');
const db = require('../../database/db');

describe('pollRunningGroupingBatches error handling', () => {
  beforeEach(() => db.importJobsAsync.markFailed.mockClear());

  it('does NOT fail the job on a transient error', async () => {
    mockRuntimeError = new Error('fetch failed');
    await __testables.pollRunningGroupingBatches();
    expect(db.importJobsAsync.markFailed).not.toHaveBeenCalled();
  });

  it('fails the job on a non-transient error', async () => {
    mockRuntimeError = new Error('invalid credentials configured');
    await __testables.pollRunningGroupingBatches();
    expect(db.importJobsAsync.markFailed).toHaveBeenCalledWith(42, 'invalid credentials configured');
  });
});
