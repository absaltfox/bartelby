'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

let db;

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
}, 60_000);

async function makeSubmittedBatchJob(remoteId) {
  const docId = await db.documentsAsync.create({
    title: 'Claim Test Doc', date_created: null, description: null,
    image_path: '/uploads/claim-test.png', metadata: {}
  });
  const txId = await db.transcriptsAsync.create({
    document_id: docId, content: 'claim test transcript', transcriber: 'Manual', version: 1, notes: null
  });
  const jobId = await db.sentimentAsync.createJob({ document_id: docId, transcript_id: txId });
  await db.runAsync(
    `UPDATE sentiment_extraction_jobs
        SET status = 'batch_submitted', kind = 'batch', batch_remote_id = ?
      WHERE id = ?`, [remoteId, jobId]
  );
  return jobId;
}

describe('sentiment claimBatchFinalization', () => {
  it('denies a second owner inside the stale window but allows same-owner re-claim', async () => {
    await makeSubmittedBatchJob('batch-claim-a');
    expect(await db.sentimentAsync.claimBatchFinalization('batch-claim-a', 'owner-1')).toBe(true);
    expect(await db.sentimentAsync.claimBatchFinalization('batch-claim-a', 'owner-2')).toBe(false);
    expect(await db.sentimentAsync.claimBatchFinalization('batch-claim-a', 'owner-1')).toBe(true);
  });

  it('allows another owner to claim after the stale window elapses', async () => {
    await makeSubmittedBatchJob('batch-claim-b');
    expect(await db.sentimentAsync.claimBatchFinalization('batch-claim-b', 'owner-1')).toBe(true);
    await db.runAsync(
      `UPDATE sentiment_extraction_jobs
          SET batch_finalization_claimed_at = datetime('now', '-3600 seconds')
        WHERE batch_remote_id = 'batch-claim-b'`
    );
    expect(await db.sentimentAsync.claimBatchFinalization('batch-claim-b', 'owner-2', 600)).toBe(true);
  });

  it('releaseBatchFinalization frees the claim for a different owner', async () => {
    await makeSubmittedBatchJob('batch-claim-c');
    expect(await db.sentimentAsync.claimBatchFinalization('batch-claim-c', 'owner-1')).toBe(true);
    await db.sentimentAsync.releaseBatchFinalization('batch-claim-c', 'owner-1');
    expect(await db.sentimentAsync.claimBatchFinalization('batch-claim-c', 'owner-2')).toBe(true);
  });
});
