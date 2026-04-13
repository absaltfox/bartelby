'use strict';

// Structural tests: verify that all job claim functions wrap their
// SELECT+UPDATE in a BEGIN EXCLUSIVE transaction to prevent two concurrent
// workers from claiming the same job.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(
  path.join(__dirname, '../../database/models/jobs.js'),
  'utf8'
);

describe('job claim functions are wrapped in BEGIN EXCLUSIVE transactions', () => {
  it('transcriptionJobs.claimNextQueued uses BEGIN EXCLUSIVE', () => {
    // Find the claimNextQueued function inside transcription_jobs context
    const match = src.match(/claimNextQueued[\s\S]{0,2000}?UPDATE transcription_jobs/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toMatch(/BEGIN EXCLUSIVE/);
  });

  it('importJobsAsync.claimNextQueuedSubmission uses BEGIN EXCLUSIVE', () => {
    const match = src.match(/claimNextQueuedSubmission[\s\S]{0,2000}?UPDATE import_jobs/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toMatch(/BEGIN EXCLUSIVE/);
  });

  it('importJobsAsync.claimNextQueuedRender uses BEGIN EXCLUSIVE', () => {
    const match = src.match(/claimNextQueuedRender[\s\S]{0,2000}?UPDATE import_jobs/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toMatch(/BEGIN EXCLUSIVE/);
  });

  it('importJobsAsync.claimNextQueuedGrouping uses BEGIN EXCLUSIVE', () => {
    const match = src.match(/claimNextQueuedGrouping[\s\S]{0,2000}?UPDATE import_jobs/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toMatch(/BEGIN EXCLUSIVE/);
  });

  it('extractionJobsAsync.claimNextQueued uses BEGIN EXCLUSIVE', () => {
    const match = src.match(/claimNextQueued[\s\S]{0,2000}?UPDATE extraction_jobs/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toMatch(/BEGIN EXCLUSIVE/);
  });

  it('all claim functions include a ROLLBACK in error handler', () => {
    const claimFns = [
      { name: 'claimNextQueued (transcription)', pattern: /claimNextQueued[\s\S]{0,2000}?UPDATE transcription_jobs[\s\S]{0,500}?ROLLBACK/ },
      { name: 'claimNextQueuedSubmission', pattern: /claimNextQueuedSubmission[\s\S]{0,2000}?ROLLBACK/ },
      { name: 'claimNextQueuedRender', pattern: /claimNextQueuedRender[\s\S]{0,2000}?ROLLBACK/ },
      { name: 'claimNextQueuedGrouping', pattern: /claimNextQueuedGrouping[\s\S]{0,2000}?ROLLBACK/ },
      { name: 'claimNextQueued (extraction)', pattern: /claimNextQueued[\s\S]{0,2000}?UPDATE extraction_jobs[\s\S]{0,500}?ROLLBACK/ },
    ];
    for (const { name, pattern } of claimFns) {
      expect({ name, matches: pattern.test(src) }).toEqual({ name, matches: true });
    }
  });
});
