'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

jest.mock('../../utils/sentiment/provider', () => ({
  callSingleton: jest.fn(),
  submitBatch: jest.fn(),
  getBatchStatus: jest.fn(async () => ({ status: 'running' })),
  fetchBatchResults: jest.fn(async () => [])
}));

const provider = require('../../utils/sentiment/provider');

let db;

beforeAll(async () => {
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
}, 60_000);

it('polls each batch with the provider recorded on its rows', async () => {
  const docId = await db.documentsAsync.create({
    title: 'D3 Doc', date_created: null, description: null,
    image_path: '/uploads/d3.png', metadata: {}
  });
  const txA = await db.transcriptsAsync.create({
    document_id: docId, content: 'a', transcriber: 'Manual', version: 1, notes: null
  });
  const txB = await db.transcriptsAsync.create({
    document_id: docId, content: 'b', transcriber: 'Manual', version: 2, notes: null
  });
  const jobA = await db.sentimentAsync.createJob({ document_id: docId, transcript_id: txA });
  const jobB = await db.sentimentAsync.createJob({ document_id: docId, transcript_id: txB });
  await db.runAsync(`UPDATE sentiment_extraction_jobs SET status='batch_submitted', kind='batch',
    batch_remote_id='batch-openai-1', provider='openai' WHERE id = ?`, [jobA]);
  await db.runAsync(`UPDATE sentiment_extraction_jobs SET status='batch_submitted', kind='batch',
    batch_remote_id='batch-claude-1', provider='claude' WHERE id = ?`, [jobB]);

  const { pollRunningSentimentBatches } = require('../../utils/worker-sentiment');
  await pollRunningSentimentBatches();

  const calledProviders = provider.getBatchStatus.mock.calls.map((c) => `${c[0].provider}:${c[0].batchId}`);
  expect(calledProviders).toEqual(expect.arrayContaining(['openai:batch-openai-1', 'claude:batch-claude-1']));
});

it('marks jobs failed when provider returns no result row, and routes fetchBatchResults by row provider', async () => {
  // Items 1 + 2: completed batch with empty results → job marked failed with "no result row"
  // and fetchBatchResults is called with the provider recorded on the row.
  provider.getBatchStatus.mockImplementation(async ({ batchId }) => ({
    status: batchId === 'batch-claude-empty' ? 'completed' : 'running'
  }));
  provider.fetchBatchResults.mockClear();
  provider.fetchBatchResults.mockResolvedValueOnce([]);

  const docId = await db.documentsAsync.create({
    title: 'R1R2 Doc', date_created: null, description: null,
    image_path: '/uploads/r1r2.png', metadata: {}
  });
  const txId = await db.transcriptsAsync.create({
    document_id: docId, content: 'test content for omit', transcriber: 'Manual', version: 1, notes: null
  });
  const jobId = await db.sentimentAsync.createJob({ document_id: docId, transcript_id: txId });
  await db.runAsync(
    `UPDATE sentiment_extraction_jobs
        SET status='batch_submitted', kind='batch', batch_remote_id='batch-claude-empty', provider='claude'
      WHERE id = ?`,
    [jobId]
  );

  const { pollRunningSentimentBatches } = require('../../utils/worker-sentiment');
  await pollRunningSentimentBatches();

  // Item 2: fetchBatchResults received the row's provider
  expect(provider.fetchBatchResults.mock.calls).toHaveLength(1);
  expect(provider.fetchBatchResults.mock.calls[0][0].provider).toBe('claude');

  // Item 1: job is now failed with "no result row" message
  const job = await db.getAsync(
    'SELECT status, error FROM sentiment_extraction_jobs WHERE id = ?',
    [jobId]
  );
  expect(job.status).toBe('failed');
  expect(job.error).toMatch(/no result row/);
});
