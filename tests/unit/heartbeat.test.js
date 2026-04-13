'use strict';

// Tests for import job heartbeat tracking and stale job recovery.

const fs = require('fs');
const path = require('path');

// --- Structural test (no DB needed) ---

describe('updateHeartbeat — structural', () => {
  it('updateHeartbeat method updates last_heartbeat_at column', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../database/models/jobs.js'),
      'utf8'
    );
    // Verify the method exists and references the correct column
    expect(src).toMatch(/updateHeartbeat/);
    expect(src).toMatch(/last_heartbeat_at/);
    // Verify it touches import_jobs
    const match = src.match(/updateHeartbeat[\s\S]{0,500}?last_heartbeat_at/);
    expect(match).not.toBeNull();
  });
});

// --- Integration tests with sql.js DB ---

describe('requeueStaleJobs — integration', () => {
  let importJobsAsync;
  let dbDriver; // raw db driver for manual SQL updates

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    // Use a short timeout so tests can produce "stale" jobs easily
    process.env.WORKER_HEARTBEAT_TIMEOUT_MS = '60000'; // 1 minute

    jest.resetModules();
    const dbModule = require('../../database/db');
    await dbModule.initializeSchema();
    importJobsAsync = dbModule.importJobsAsync;
    dbDriver = dbModule.getDb();
  });

  afterAll(() => {
    delete process.env.WORKER_HEARTBEAT_TIMEOUT_MS;
  });

  it('requeues a processing import job with a stale heartbeat', async () => {
    // Create a job via the model (user_id NULL to avoid FK constraint in test DB)
    const jobId = await importJobsAsync.create({
      original_name: 'test-heartbeat.pdf',
      file_path: 'test-heartbeat.pdf',
      user_id: null,
      job_kind: 'render',
    });
    expect(jobId).toBeTruthy();

    // Manually put it in the state a Fly machine would leave it: processing,
    // machine_id set, and last_heartbeat_at 10 minutes ago (over the 1-min threshold)
    dbDriver.run(`
      UPDATE import_jobs
      SET status = 'processing',
          machine_id = 'fake-fly-machine-abc123',
          last_heartbeat_at = datetime('now', '-600 seconds')
      WHERE id = ?
    `, [jobId]);

    const count = await importJobsAsync.requeueStaleJobs();
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify the job is now queued with fields cleared
    const job = dbDriver.get('SELECT * FROM import_jobs WHERE id = ?', [jobId]);
    expect(job.status).toBe('queued');
    expect(job.machine_id).toBeNull();
    expect(job.last_heartbeat_at).toBeNull();
    expect(job.started_at).toBeNull();
  });

  it('does not requeue a processing job with no heartbeat set (non-Fly job)', async () => {
    const jobId = await importJobsAsync.create({
      original_name: 'test-no-heartbeat.pdf',
      file_path: 'test-no-heartbeat.pdf',
      user_id: null,
      job_kind: 'render',
    });

    // Processing with machine_id but last_heartbeat_at is NULL (legacy/non-Fly)
    dbDriver.run(`
      UPDATE import_jobs
      SET status = 'processing',
          machine_id = 'some-machine',
          last_heartbeat_at = NULL
      WHERE id = ?
    `, [jobId]);

    const before = dbDriver.get('SELECT status FROM import_jobs WHERE id = ?', [jobId]);
    expect(before.status).toBe('processing');

    await importJobsAsync.requeueStaleJobs();

    const after = dbDriver.get('SELECT status FROM import_jobs WHERE id = ?', [jobId]);
    expect(after.status).toBe('processing'); // unchanged
  });

  it('does not requeue a job whose heartbeat is recent', async () => {
    const jobId = await importJobsAsync.create({
      original_name: 'test-fresh-heartbeat.pdf',
      file_path: 'test-fresh-heartbeat.pdf',
      user_id: null,
      job_kind: 'render',
    });

    // Processing with a fresh heartbeat (10 seconds ago, under the 1-min threshold)
    dbDriver.run(`
      UPDATE import_jobs
      SET status = 'processing',
          machine_id = 'fly-machine-xyz',
          last_heartbeat_at = datetime('now', '-10 seconds')
      WHERE id = ?
    `, [jobId]);

    await importJobsAsync.requeueStaleJobs();

    const after = dbDriver.get('SELECT status FROM import_jobs WHERE id = ?', [jobId]);
    expect(after.status).toBe('processing'); // still running
  });
});
