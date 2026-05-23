'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('worker-sentiment-reconciliation', () => {
  let db;
  let reconcileSentimentBatches;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-reconcile-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();

    jest.doMock('../../utils/sentiment-batches', () => ({
      listSentimentBatchesByCorrelation: jest.fn(),
      supportsSentimentBatchProvider: jest.fn(() => true)
    }));

    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    await db.runAsync(`INSERT INTO documents (id, title) VALUES (1, 'Doc')`);
    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1, 1, 'text')`);
    ({ reconcileSentimentBatches } = require('../../utils/worker-sentiment-reconciliation'));
  });

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function makeOrphanRow({ provider, correlationId, ageMinutes = 5 }) {
    const jobId = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    await db.runAsync(`
      UPDATE sentiment_extraction_jobs
         SET status = 'running',
             kind = 'batch',
             provider = ?,
             batch_remote_id = ?,
             batch_submitted_at = datetime('now', '-' || ? || ' minutes')
       WHERE id = ?
    `, [provider, correlationId, String(ageMinutes), jobId]);
    return jobId;
  }

  test('early-exits when no pending-* rows exist', async () => {
    const result = await reconcileSentimentBatches();
    expect(result.matched).toBe(0);
    expect(result.providers).toEqual({});
    const sentimentBatches = require('../../utils/sentiment-batches');
    expect(sentimentBatches.listSentimentBatchesByCorrelation).not.toHaveBeenCalled();
  });

  test('flips matched row to real batch_remote_id and status=batch_submitted', async () => {
    const jobId = await makeOrphanRow({ provider: 'vertex', correlationId: 'pending-v-1' });
    const sentimentBatches = require('../../utils/sentiment-batches');
    sentimentBatches.listSentimentBatchesByCorrelation.mockResolvedValueOnce([
      { correlationId: 'pending-v-1',
        batchId: 'projects/p/locations/global/batchPredictionJobs/111',
        providerState: 'JOB_STATE_PENDING' }
    ]);
    const result = await reconcileSentimentBatches();
    expect(result.matched).toBe(1);
    expect(result.providers.vertex).toBe(1);
    const row = await db.getAsync(`SELECT status, batch_remote_id FROM sentiment_extraction_jobs WHERE id = ?`, [jobId]);
    expect(row.status).toBe('batch_submitted');
    expect(row.batch_remote_id).toBe('projects/p/locations/global/batchPredictionJobs/111');
  });

  test('per-provider failure does not abort other providers', async () => {
    await makeOrphanRow({ provider: 'vertex', correlationId: 'pending-v-1' });
    const okJobId = await makeOrphanRow({ provider: 'openai', correlationId: 'pending-o-1' });
    const sentimentBatches = require('../../utils/sentiment-batches');
    sentimentBatches.listSentimentBatchesByCorrelation.mockImplementation(async ({ provider }) => {
      if (provider === 'vertex') throw new Error('boom');
      if (provider === 'openai') return [{ correlationId: 'pending-o-1', batchId: 'batch_x', providerState: 'in_progress' }];
      return [];
    });
    const result = await reconcileSentimentBatches();
    expect(result.matched).toBe(1);
    expect(result.providers.openai).toBe(1);
    expect(result.providers.vertex).toBe(0);
    const row = await db.getAsync(`SELECT status, batch_remote_id FROM sentiment_extraction_jobs WHERE id = ?`, [okJobId]);
    expect(row.status).toBe('batch_submitted');
    expect(row.batch_remote_id).toBe('batch_x');
  });

  test('skips orphan rows with provider=NULL (pre-1.6a legacy) and continues', async () => {
    const okJobId = await makeOrphanRow({ provider: 'vertex', correlationId: 'pending-v-1' });
    // Legacy row: provider=NULL
    const legacyJobId = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    await db.runAsync(`
      UPDATE sentiment_extraction_jobs
         SET status='running', kind='batch', provider=NULL,
             batch_remote_id='pending-legacy', batch_submitted_at=datetime('now','-5 minutes')
       WHERE id=?`, [legacyJobId]);

    const sentimentBatches = require('../../utils/sentiment-batches');
    sentimentBatches.listSentimentBatchesByCorrelation.mockResolvedValueOnce([
      { correlationId: 'pending-v-1', batchId: 'projects/p/locations/global/batchPredictionJobs/111', providerState: 'JOB_STATE_PENDING' }
    ]);
    const result = await reconcileSentimentBatches();
    expect(result.matched).toBe(1);
    const ok = await db.getAsync(`SELECT status FROM sentiment_extraction_jobs WHERE id = ?`, [okJobId]);
    const legacy = await db.getAsync(`SELECT status, batch_remote_id FROM sentiment_extraction_jobs WHERE id = ?`, [legacyJobId]);
    expect(ok.status).toBe('batch_submitted');
    expect(legacy.status).toBe('running');
    expect(legacy.batch_remote_id).toBe('pending-legacy');
  });

  test('returns busy when called concurrently with itself', async () => {
    await makeOrphanRow({ provider: 'vertex', correlationId: 'pending-v-1' });
    const sentimentBatches = require('../../utils/sentiment-batches');
    let release;
    const blocker = new Promise((resolve) => { release = resolve; });
    sentimentBatches.listSentimentBatchesByCorrelation.mockImplementation(() => blocker.then(() => []));
    const first = reconcileSentimentBatches();
    const second = await reconcileSentimentBatches();
    expect(second).toEqual({ matched: 0, skipped: 'busy' });
    release();
    await first;
  });
});
