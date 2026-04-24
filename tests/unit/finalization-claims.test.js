'use strict';

describe('batch finalization claim recovery', () => {
  let dbModule;
  let dbDriver;

  function createDocumentWithTranscript(suffix) {
    const documentId = dbDriver.run(`
      INSERT INTO documents (title, image_path, metadata)
      VALUES (?, 'stub.png', '{}')
    `, [`Test document ${suffix}`]).lastInsertRowid;

    const transcriptId = dbDriver.run(`
      INSERT INTO transcripts (document_id, content, transcriber)
      VALUES (?, ?, 'test')
    `, [documentId, `Transcript ${suffix}`]).lastInsertRowid;

    return { documentId, transcriptId };
  }

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    process.env.BATCH_FINALIZATION_STALE_SECONDS = '60';
    process.env.EXTRACTION_BATCH_FINALIZATION_STALE_SECONDS = '60';

    jest.resetModules();
    dbModule = require('../../database/db');
    await dbModule.initializeSchema();
    dbDriver = dbModule.getDb();
  });

  afterAll(() => {
    delete process.env.BATCH_FINALIZATION_STALE_SECONDS;
    delete process.env.EXTRACTION_BATCH_FINALIZATION_STALE_SECONDS;
  });

  it('preserves fresh transcription and extraction finalization claims on startup', async () => {
    const freshTx = createDocumentWithTranscript('fresh-tx');
    const freshExtraction = createDocumentWithTranscript('fresh-extraction');

    const txJobId = dbDriver.run(`
      INSERT INTO transcription_jobs (
        document_id, provider, model, temperature, initiated_by, image_path,
        status, log, job_kind, batch_remote_id, batch_remote_status,
        batch_finalization_claimed_at, batch_finalization_claimed_by
      ) VALUES (?, 'vertex', 'default', NULL, 'test', 'stub.png', 'running', '', 'batch', 'remote-tx', 'completed', CURRENT_TIMESTAMP, 'instance-a')
    `, [freshTx.documentId]).lastInsertRowid;

    const extractionJobId = dbDriver.run(`
      INSERT INTO extraction_jobs (
        transcript_id, document_id, provider, model, temperature, initiated_by,
        reset_existing, job_kind, batch_display_name, batch_document_count,
        batch_manifest, status, log, batch_remote_id, batch_remote_status,
        batch_finalization_claimed_at, batch_finalization_claimed_by
      ) VALUES (?, ?, 'vertex', 'default', NULL, 'test', 0, 'batch', 'test batch', 1, NULL, 'running', '', 'remote-ex', 'JOB_STATE_SUCCEEDED', CURRENT_TIMESTAMP, 'instance-b')
    `, [freshExtraction.transcriptId, freshExtraction.documentId]).lastInsertRowid;

    await dbModule.initializeSchema();

    const txRow = dbDriver.get('SELECT batch_finalization_claimed_by FROM transcription_jobs WHERE id = ?', [txJobId]);
    const extractionRow = dbDriver.get('SELECT batch_finalization_claimed_by FROM extraction_jobs WHERE id = ?', [extractionJobId]);

    expect(txRow.batch_finalization_claimed_by).toBe('instance-a');
    expect(extractionRow.batch_finalization_claimed_by).toBe('instance-b');
  });

  it('clears stale transcription and extraction finalization claims on startup', async () => {
    const staleTx = createDocumentWithTranscript('stale-tx');
    const staleExtraction = createDocumentWithTranscript('stale-extraction');

    const txJobId = dbDriver.run(`
      INSERT INTO transcription_jobs (
        document_id, provider, model, temperature, initiated_by, image_path,
        status, log, job_kind, batch_remote_id, batch_remote_status,
        batch_finalization_claimed_at, batch_finalization_claimed_by
      ) VALUES (?, 'vertex', 'default', NULL, 'test', 'stub.png', 'running', '', 'batch', 'remote-tx-2', 'completed', datetime('now', '-120 seconds'), 'instance-c')
    `, [staleTx.documentId]).lastInsertRowid;

    const extractionJobId = dbDriver.run(`
      INSERT INTO extraction_jobs (
        transcript_id, document_id, provider, model, temperature, initiated_by,
        reset_existing, job_kind, batch_display_name, batch_document_count,
        batch_manifest, status, log, batch_remote_id, batch_remote_status,
        batch_finalization_claimed_at, batch_finalization_claimed_by
      ) VALUES (?, ?, 'vertex', 'default', NULL, 'test', 0, 'batch', 'stale batch', 1, NULL, 'running', '', 'remote-ex-2', 'JOB_STATE_SUCCEEDED', datetime('now', '-120 seconds'), 'instance-d')
    `, [staleExtraction.transcriptId, staleExtraction.documentId]).lastInsertRowid;

    await dbModule.initializeSchema();

    const txRow = dbDriver.get('SELECT batch_finalization_claimed_by FROM transcription_jobs WHERE id = ?', [txJobId]);
    const extractionRow = dbDriver.get('SELECT batch_finalization_claimed_by FROM extraction_jobs WHERE id = ?', [extractionJobId]);

    expect(txRow.batch_finalization_claimed_by).toBeNull();
    expect(extractionRow.batch_finalization_claimed_by).toBeNull();
  });
});
