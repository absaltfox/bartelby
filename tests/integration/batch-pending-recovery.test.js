// tests/integration/batch-pending-recovery.test.js
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

async function makeDocAndTranscript(tag) {
  const docId = await db.documentsAsync.create({
    title: `Pending Recovery ${tag}`, date_created: null, description: null,
    image_path: `/uploads/pending-${tag}.png`, metadata: {}
  });
  const txId = await db.transcriptsAsync.create({
    document_id: docId, content: 'pending recovery transcript', transcriber: 'Manual', version: 1, notes: null
  });
  return { docId, txId };
}

describe('startup recovery for batch jobs stranded on the pending sentinel', () => {
  it('fails a stale pending transcription batch and preserves the sentinel in the error', async () => {
    const { docId } = await makeDocAndTranscript('tx');
    const r = await db.runAsync(`
      INSERT INTO transcription_jobs
        (document_id, provider, status, job_kind, batch_remote_id, image_path, started_at, created_at)
      VALUES (?, 'openai', 'running', 'batch', 'pending-stale-uuid-1', 'stub.png',
              datetime('now', '-3600 seconds'), datetime('now', '-3600 seconds'))
    `, [docId]);
    const jobId = r.lastInsertRowid;

    await db.initializeSchema();

    const job = await db.getAsync('SELECT status, error FROM transcription_jobs WHERE id = ?', [jobId]);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('pending-stale-uuid-1');
  });

  it('leaves a FRESH pending transcription batch running (live submission window)', async () => {
    const { docId } = await makeDocAndTranscript('tx-fresh');
    const r = await db.runAsync(`
      INSERT INTO transcription_jobs
        (document_id, provider, status, job_kind, batch_remote_id, image_path, started_at, created_at)
      VALUES (?, 'openai', 'running', 'batch', 'pending-fresh-uuid-1', 'stub.png',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [docId]);
    const jobId = r.lastInsertRowid;

    await db.initializeSchema();

    const job = await db.getAsync('SELECT status FROM transcription_jobs WHERE id = ?', [jobId]);
    expect(job.status).toBe('running');
  });

  it('fails a stale pending extraction batch', async () => {
    const { docId, txId } = await makeDocAndTranscript('ex');
    const r = await db.runAsync(`
      INSERT INTO extraction_jobs
        (document_id, transcript_id, provider, status, job_kind, batch_remote_id, started_at, created_at)
      VALUES (?, ?, 'openai', 'running', 'batch', 'pending-stale-uuid-2',
              datetime('now', '-3600 seconds'), datetime('now', '-3600 seconds'))
    `, [docId, txId]);
    const jobId = r.lastInsertRowid;

    await db.initializeSchema();

    const job = await db.getAsync('SELECT status, error FROM extraction_jobs WHERE id = ?', [jobId]);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('pending-stale-uuid-2');
  });
});
