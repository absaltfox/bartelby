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

it('retry of a done sentiment job re-queues with reset_existing = 1', async () => {
  const docId = await db.documentsAsync.create({
    title: 'D2 Doc', date_created: null, description: null,
    image_path: '/uploads/d2.png', metadata: {}
  });
  const txId = await db.transcriptsAsync.create({
    document_id: docId, content: 'retry reset transcript', transcriber: 'Manual', version: 1, notes: null
  });
  const jobId = await db.sentimentAsync.createJob({ document_id: docId, transcript_id: txId });
  await db.sentimentAsync.markDone(jobId, {});

  await db.sentimentAsync.retry(jobId);

  const job = await db.sentimentAsync.getJobById(jobId);
  expect(job.status).toBe('queued');
  expect(job.reset_existing).toBe(1);
});
