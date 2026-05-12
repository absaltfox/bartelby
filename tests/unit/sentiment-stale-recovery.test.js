'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('sentiment stale-job recovery', () => {
  let db;
  let tmpDir;

  async function reset() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentiment-stale-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    await db.runAsync(`INSERT INTO documents (id, title) VALUES (1, 'Doc')`);
    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1, 1, 'x')`);
  }

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('singleton running → failed after recovery', async () => {
    await reset();
    await db.runAsync(
      `INSERT INTO sentiment_extraction_jobs
         (document_id, transcript_id, status, kind, started_at)
       VALUES (1, 1, 'running', 'singleton', CURRENT_TIMESTAMP)`
    );
    await db.initializeSchema({ runStaleJobRecovery: true });
    const row = await db.getAsync(`SELECT status, error FROM sentiment_extraction_jobs WHERE id = 1`);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/restart/i);
  });

  test('batch running with finalization claim → claim cleared, status untouched', async () => {
    await reset();
    await db.runAsync(
      `INSERT INTO sentiment_extraction_jobs
         (document_id, transcript_id, status, kind,
          batch_finalization_claimed_at, batch_finalization_claimed_by, batch_remote_id)
       VALUES (1, 1, 'running', 'batch', CURRENT_TIMESTAMP, 'web-1', 'remote-abc')`
    );
    await db.initializeSchema({ runStaleJobRecovery: true });
    const row = await db.getAsync(`SELECT status, batch_finalization_claimed_at FROM sentiment_extraction_jobs WHERE id = 1`);
    expect(row.status).toBe('failed');
    expect(row.batch_finalization_claimed_at).toBeNull();
  });

  test('batch_submitted untouched', async () => {
    await reset();
    await db.runAsync(
      `INSERT INTO sentiment_extraction_jobs
         (document_id, transcript_id, status, kind, batch_remote_id, batch_submitted_at)
       VALUES (1, 1, 'batch_submitted', 'batch', 'remote-xyz', CURRENT_TIMESTAMP)`
    );
    await db.initializeSchema({ runStaleJobRecovery: true });
    const row = await db.getAsync(`SELECT status FROM sentiment_extraction_jobs WHERE id = 1`);
    expect(row.status).toBe('batch_submitted');
  });

  test('batch running with pending-* placeholder → failed + correlation logged', async () => {
    await reset();
    await db.runAsync(
      `INSERT INTO sentiment_extraction_jobs
         (document_id, transcript_id, status, kind, batch_remote_id)
       VALUES (1, 1, 'running', 'batch', 'pending-abc123')`
    );
    await db.initializeSchema({ runStaleJobRecovery: true });
    const row = await db.getAsync(
      `SELECT status, error FROM sentiment_extraction_jobs WHERE id = 1`
    );
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/pending-abc123/);
    expect(row.error).toMatch(/orphaned/i);
  });

  test('batch running with no batch_remote_id → failed (never staged)', async () => {
    await reset();
    await db.runAsync(
      `INSERT INTO sentiment_extraction_jobs
         (document_id, transcript_id, status, kind)
       VALUES (1, 1, 'running', 'batch')`
    );
    await db.initializeSchema({ runStaleJobRecovery: true });
    const row = await db.getAsync(
      `SELECT status, error FROM sentiment_extraction_jobs WHERE id = 1`
    );
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/before batch submission/i);
  });
});
