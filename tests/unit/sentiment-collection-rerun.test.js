'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('sentiment collection re-run model', () => {
  let db;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentiment-rerun-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
  });

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Insert a best transcript in a collection; return { docId, transcriptId }.
  async function addTranscript(collectionId, i) {
    const docId = (await db.runAsync(`INSERT INTO documents (title) VALUES (?)`, [`d-${collectionId}-${i}`])).lastInsertRowid;
    await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (?, ?)`, [docId, collectionId]);
    const transcriptId = (await db.runAsync(
      `INSERT INTO transcripts (document_id, content, is_best) VALUES (?, 'x', 1)`, [docId]
    )).lastInsertRowid;
    return { docId, transcriptId };
  }

  async function addJob(docId, transcriptId, status) {
    return (await db.runAsync(
      `INSERT INTO sentiment_extraction_jobs (document_id, transcript_id, reset_existing, status, kind, created_at)
       VALUES (?, ?, 0, ?, 'singleton', CURRENT_TIMESTAMP)`,
      [docId, transcriptId, status]
    )).lastInsertRowid;
  }

  async function addAnnotation(docId, transcriptId, approvalStatus) {
    await db.runAsync(
      `INSERT INTO sentiment_annotations
         (transcript_id, document_id, polarity, intensity, voice_role, target_kind, emotion_phrase_verbatim, approval_status)
       VALUES (?, ?, 'positive', 'low', 'author', 'phrase', 'x', ?)`,
      [transcriptId, docId, approvalStatus]
    );
  }

  it('resets done jobs, queues no-job transcripts, and skips in-flight/failed', async () => {
    const collectionId = await db.collectionsAsync.create({ name: 'C', createdBy: null });

    const done = await addTranscript(collectionId, 'done');
    const doneJobId = await addJob(done.docId, done.transcriptId, 'done');
    await addAnnotation(done.docId, done.transcriptId, 'approved');
    await addAnnotation(done.docId, done.transcriptId, 'pending');

    const fresh = await addTranscript(collectionId, 'fresh'); // no job

    const running = await addTranscript(collectionId, 'running');
    await addJob(running.docId, running.transcriptId, 'running');

    const failed = await addTranscript(collectionId, 'failed');
    const failedJobId = await addJob(failed.docId, failed.transcriptId, 'failed');

    const preview = await db.sentimentAsync.getCollectionRerunPreview(collectionId);
    expect(preview).toEqual({
      resetCount: 1, queueCount: 1, inFlightSkipped: 1,
      annotationsTotal: 2, annotationsApproved: 1
    });

    const result = await db.sentimentAsync.rerunCollectionSentiment(collectionId);
    expect(result).toEqual({ reset: 1, queued: 1, skippedInFlight: 1 });

    // done job → queued + reset_existing
    const doneJob = await db.getAsync(`SELECT status, reset_existing FROM sentiment_extraction_jobs WHERE id = ?`, [doneJobId]);
    expect(doneJob.status).toBe('queued');
    expect(doneJob.reset_existing).toBe(1);

    // fresh transcript → new queued job, reset_existing = 0
    const freshJob = await db.getAsync(
      `SELECT status, reset_existing FROM sentiment_extraction_jobs WHERE transcript_id = ?`, [fresh.transcriptId]
    );
    expect(freshJob.status).toBe('queued');
    expect(freshJob.reset_existing).toBe(0);

    // failed job untouched, no new job created for it
    const failedRows = await db.allAsync(`SELECT id, status FROM sentiment_extraction_jobs WHERE transcript_id = ?`, [failed.transcriptId]);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].id).toBe(failedJobId);
    expect(failedRows[0].status).toBe('failed');
  });

  it('does not reset a done job when the same transcript also has an in-flight job', async () => {
    const collectionId = await db.collectionsAsync.create({ name: 'C2', createdBy: null });

    // One transcript with BOTH a done job and a running job.
    const t = await addTranscript(collectionId, 'dual');
    const doneJobId = await addJob(t.docId, t.transcriptId, 'done');
    await addJob(t.docId, t.transcriptId, 'running');

    // Preview must classify this as in-flight → skipped (resetCount 0, inFlightSkipped 1).
    const preview = await db.sentimentAsync.getCollectionRerunPreview(collectionId);
    expect(preview.resetCount).toBe(0);
    expect(preview.inFlightSkipped).toBe(1);
    expect(preview.queueCount).toBe(0);

    // Mutation must not touch the done job.
    const result = await db.sentimentAsync.rerunCollectionSentiment(collectionId);
    expect(result.reset).toBe(0);
    expect(result.skippedInFlight).toBe(1);

    const doneJob = await db.getAsync(`SELECT status FROM sentiment_extraction_jobs WHERE id = ?`, [doneJobId]);
    expect(doneJob.status).toBe('done');
  });
});
