'use strict';

// Regression test for the standalone PDF worker race that killed in-flight
// grouping submissions. See docs/background-jobs.md § Graceful Shutdown and
// Stale Job Recovery.

const fs = require('fs');
const path = require('path');

describe('initializeSchema({ runStaleJobRecovery: false })', () => {
  let dbModule;
  let dbDriver;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';

    jest.resetModules();
    dbModule = require('../../database/db');
    await dbModule.initializeSchema();
    dbDriver = dbModule.getDb();
  });

  it('does not mark in-flight grouping submissions as failed', async () => {
    const jobId = await dbModule.importJobsAsync.create({
      original_name: 'Auto Grouping 994 pages',
      file_path: 'grouping-994.json',
      user_id: null,
      job_kind: 'grouping',
    });

    // Simulate the state of a grouping submission held by another live
    // worker: processing, no batch_remote_id yet (still uploading inputs).
    dbDriver.run(`
      UPDATE import_jobs
      SET status = 'processing',
          batch_remote_id = NULL,
          started_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [jobId]);

    // A second startup (e.g. ephemeral PDF render Fly machine) calls
    // initializeSchema with recovery disabled — it must NOT touch the
    // grouping job owned by the main worker.
    await dbModule.initializeSchema({ runStaleJobRecovery: false });

    const after = dbDriver.get('SELECT status, error FROM import_jobs WHERE id = ?', [jobId]);
    expect(after.status).toBe('processing');
    expect(after.error).toBeNull();
  });

  it('still marks stale grouping submissions failed when recovery runs', async () => {
    const jobId = await dbModule.importJobsAsync.create({
      original_name: 'Auto Grouping 50 pages',
      file_path: 'grouping-50.json',
      user_id: null,
      job_kind: 'grouping',
    });

    dbDriver.run(`
      UPDATE import_jobs
      SET status = 'processing',
          batch_remote_id = NULL,
          started_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [jobId]);

    // Default behavior: recovery sweep runs and marks failed.
    await dbModule.initializeSchema();

    const after = dbDriver.get('SELECT status, error FROM import_jobs WHERE id = ?', [jobId]);
    expect(after.status).toBe('failed');
    expect(after.error).toBe('Server restarted during processing');
  });
});

describe('sentiment batch stale-claim recovery', () => {
  let dbModule;
  let dbDriver;
  let tmpDir;

  beforeEach(async () => {
    const os = require('os');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-recovery-'));
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    process.env.SENTIMENT_BATCH_FINALIZATION_STALE_SECONDS = '0';

    jest.resetModules();
    dbModule = require('../../database/db');
    await dbModule.initializeSchema({ runStaleJobRecovery: false });
    dbDriver = dbModule.getDb();
    await dbModule.runAsync(`INSERT INTO documents (id, title) VALUES (1, 'Doc')`);
    await dbModule.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1, 1, 'text')`);
  });

  afterEach(async () => {
    if (dbModule?.closeAsync) await dbModule.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clears stale finalization claim on batch_submitted rows (does not fail them)', async () => {
    // Simulate a row left in batch_submitted with a claim from a prior, now-dead process.
    const jobId = await dbModule.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    await dbModule.runAsync(`
      UPDATE sentiment_extraction_jobs
         SET status = 'batch_submitted',
             batch_remote_id = 'projects/p/locations/global/batchPredictionJobs/12345',
             batch_submitted_at = datetime('now', '-1 hour'),
             batch_finalization_claimed_at = datetime('now', '-30 minutes'),
             batch_finalization_claimed_by = 'host-old-pid'
       WHERE id = ?
    `, [jobId]);

    await dbModule.initializeSchema();

    const after = await dbModule.getAsync(
      'SELECT status, batch_remote_id, batch_finalization_claimed_at, batch_finalization_claimed_by, error FROM sentiment_extraction_jobs WHERE id = ?',
      [jobId]
    );
    // Status stays batch_submitted so the next worker tick can re-claim and
    // finalize; only the claim is released.
    expect(after.status).toBe('batch_submitted');
    expect(after.batch_remote_id).toBe('projects/p/locations/global/batchPredictionJobs/12345');
    expect(after.batch_finalization_claimed_at).toBeNull();
    expect(after.batch_finalization_claimed_by).toBeNull();
    expect(after.error).toBeNull();
  });

  it('marks pending-* placeholder rows failed when in real orphan state (status=running, kind=batch)', async () => {
    const jobId = await dbModule.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    // The REAL orphan window — what markBatchPending leaves behind if the
    // worker crashes before markBatchSubmittedByCorrelation lands.
    await dbModule.runAsync(`
      UPDATE sentiment_extraction_jobs
         SET status = 'running',
             kind = 'batch',
             batch_remote_id = 'pending-aaaa-bbbb',
             batch_submitted_at = datetime('now', '-1 hour')
       WHERE id = ?
    `, [jobId]);

    await dbModule.initializeSchema();

    const after = await dbModule.getAsync(
      'SELECT status, error FROM sentiment_extraction_jobs WHERE id = ?',
      [jobId]
    );
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/orphaned batch.*pending-aaaa-bbbb/);
  });
});

describe('Phase 2a clustering schema (migration v70)', () => {
  let dbModule;
  let dbDriver;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    jest.resetModules();
    dbModule = require('../../database/db');
    await dbModule.initializeSchema();
    dbDriver = dbModule.getDb();
  });

  it('creates sentiment_phrase_cluster_runs with expected columns', () => {
    const cols = dbDriver.all(`PRAGMA table_info(sentiment_phrase_cluster_runs)`);
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'id', 'status', 'params_json', 'cluster_count', 'noise_count',
      'phrase_count', 'error', 'attempts', 'triggered_by_user_id',
      'created_at', 'started_at', 'completed_at'
    ]));
  });

  it('creates sentiment_phrase_clusters with run_id FK', () => {
    const cols = dbDriver.all(`PRAGMA table_info(sentiment_phrase_clusters)`);
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'run_id', 'cluster_index', 'size', 'created_at']));
  });

  it('creates sentiment_phrase_cluster_members with composite PK', () => {
    const cols = dbDriver.all(`PRAGMA table_info(sentiment_phrase_cluster_members)`);
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['cluster_id', 'phrase_id', 'distance_to_centroid']));
  });
});

describe('pdf-worker standalone wiring', () => {
  it('runStandalone opts out of stale-job recovery', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../utils/pdf-worker.js'),
      'utf8'
    );
    expect(src).toMatch(/initializeSchema\(\{\s*runStaleJobRecovery:\s*false\s*\}\)/);
  });
});
