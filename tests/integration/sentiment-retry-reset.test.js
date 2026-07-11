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

async function createDoneJob(suffix) {
  const docId = await db.documentsAsync.create({
    title: `D2 Doc ${suffix}`, date_created: null, description: null,
    image_path: `/uploads/d2-${suffix}.png`, metadata: {}
  });
  const txId = await db.transcriptsAsync.create({
    document_id: docId, content: 'retry reset transcript', transcriber: 'Manual', version: 1, notes: null
  });
  const jobId = await db.sentimentAsync.createJob({ document_id: docId, transcript_id: txId });
  await db.sentimentAsync.markDone(jobId, {});
  return { docId, txId, jobId };
}

it('retry of a done job whose transcript has annotations forces reset_existing = 1', async () => {
  const { docId, txId, jobId } = await createDoneJob('with-annotations');
  await db.sentimentAsync.writeAnnotationsForJob(jobId, [{
    transcript_id: txId,
    document_id: docId,
    span_start: 0,
    span_end: 5,
    evidence_excerpt: 'retry',
    polarity: 'positive',
    intensity: 'moderate',
    confidence: 0.9,
    voice_role: 'author',
    target_kind: 'phrase',
    target_phrase: 'retry',
    emotion_phrase_verbatim: 'gladness',
    extracted_by: 'test',
    extraction_job_id: jobId,
    extracted_at: new Date().toISOString()
  }]);

  await db.sentimentAsync.retry(jobId);

  const job = await db.sentimentAsync.getJobById(jobId);
  expect(job.status).toBe('queued');
  expect(job.reset_existing).toBe(1);
});

it('retry of a done job with no annotations preserves reset_existing', async () => {
  const { jobId } = await createDoneJob('no-annotations');

  await db.sentimentAsync.retry(jobId);

  const job = await db.sentimentAsync.getJobById(jobId);
  expect(job.status).toBe('queued');
  expect(job.reset_existing).toBe(0);
});
