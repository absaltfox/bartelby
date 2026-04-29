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

describe('pdf-worker standalone wiring', () => {
  it('runStandalone opts out of stale-job recovery', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../utils/pdf-worker.js'),
      'utf8'
    );
    expect(src).toMatch(/initializeSchema\(\{\s*runStaleJobRecovery:\s*false\s*\}\)/);
  });
});
