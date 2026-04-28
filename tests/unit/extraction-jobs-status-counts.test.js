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
