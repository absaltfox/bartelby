'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

describe('extractionJobsAsync.getStatusCounts', () => {
  let db;

  beforeAll(async () => {
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
  });

  test('returns total + per-status buckets', async () => {
    const documentId = await db.documentsAsync.create({
      title: 'Extraction Counts Doc',
      date_created: null,
      description: null,
      image_path: '/uploads/extraction-counts.png',
      metadata: {}
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Transcript content for extraction counts test',
      transcriber: 'Manual',
      version: 1,
      notes: null
    });

    await db.extractionJobsAsync.create({
      transcript_id: transcriptId,
      document_id: documentId,
      provider: 'openai',
      model: 'x'
    });
    await db.extractionJobsAsync.create({
      transcript_id: transcriptId,
      document_id: documentId,
      provider: 'openai',
      model: 'x'
    });

    const counts = await db.extractionJobsAsync.getStatusCounts();
    expect(counts).toEqual(expect.objectContaining({
      total: expect.any(Number),
      queued: expect.any(Number),
      running: expect.any(Number),
      done: expect.any(Number),
      failed: expect.any(Number)
    }));
    expect(counts.total).toBeGreaterThanOrEqual(2);
    expect(counts.queued).toBeGreaterThanOrEqual(2);
  });
});

describe('extractionJobs.markDone unresolved counters', () => {
  let db;

  beforeAll(async () => {
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
  });

  it('persists unresolved_relationship_count and unresolved_date_count', async () => {
    const documentId = await db.documentsAsync.create({
      title: 'Unresolved Counters Doc',
      date_created: null,
      description: null,
      image_path: '/uploads/unresolved-counters.png',
      metadata: {}
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Transcript content for unresolved counters test',
      transcriber: 'Manual',
      version: 1,
      notes: null
    });
    const jobId = await db.extractionJobsAsync.create({
      transcript_id: transcriptId,
      document_id: documentId,
      provider: 'test',
      model: 'test',
      temperature: 0,
      initiated_by: null,
      provider_key_scope: null,
      user_api_key_id: null,
      requested_by_user_id: null,
      reset_existing: false,
      job_kind: 'single',
      batch_display_name: null,
      batch_document_count: 1,
      batch_manifest: null
    });
    await db.extractionJobs.markDone(jobId, {
      entity_count: 5,
      relationship_count: 3,
      unresolved_relationship_count: 2,
      unresolved_date_count: 1
    });
    const job = await db.extractionJobsAsync.getById(jobId);
    expect(job.unresolved_relationship_count).toBe(2);
    expect(job.unresolved_date_count).toBe(1);
  });
});
