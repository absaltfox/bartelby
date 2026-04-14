'use strict';

// Structural tests: verify that all job claim functions use withExclusiveLock
// (which applies BEGIN EXCLUSIVE on local SQLite and optimistic locking on Turso)
// and that withExclusiveLock itself uses BEGIN EXCLUSIVE and ROLLBACK for SQLite.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(
  path.join(__dirname, '../../database/models/jobs.js'),
  'utf8'
);

describe('job claim functions use withExclusiveLock', () => {
  it('withExclusiveLock helper is defined and uses BEGIN EXCLUSIVE', () => {
    expect(src).toContain('withExclusiveLock');
    expect(src).toContain('BEGIN EXCLUSIVE');
    expect(src).toContain("db.kind === 'turso'");
  });

  it('withExclusiveLock uses ROLLBACK on error', () => {
    expect(src).toContain('ROLLBACK');
  });

  it('transcriptionJobs.claimNextQueued delegates to withExclusiveLock', () => {
    const match = src.match(/claimNextQueued[\s\S]{0,2000}?UPDATE transcription_jobs/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('withExclusiveLock');
  });

  it('importJobsAsync.claimNextQueuedSubmission delegates to withExclusiveLock', () => {
    const match = src.match(/claimNextQueuedSubmission[\s\S]{0,2000}?UPDATE import_jobs/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('withExclusiveLock');
  });

  it('importJobsAsync.claimNextQueuedRender delegates to withExclusiveLock', () => {
    const match = src.match(/claimNextQueuedRender[\s\S]{0,2000}?UPDATE import_jobs/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('withExclusiveLock');
  });

  it('importJobsAsync.claimNextQueuedGrouping delegates to withExclusiveLock', () => {
    const match = src.match(/claimNextQueuedGrouping[\s\S]{0,2000}?UPDATE import_jobs/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('withExclusiveLock');
  });

  it('extractionJobsAsync.claimNextQueued delegates to withExclusiveLock', () => {
    const match = src.match(/claimNextQueued[\s\S]{0,2000}?UPDATE extraction_jobs/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('withExclusiveLock');
  });
});
