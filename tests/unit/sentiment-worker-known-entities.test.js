'use strict';

// P0 of docs/2026-07-05-epistolary-register-design.md — regression tests for
// findings D1 and D2 in docs/reviews/2026-07-04-sentiment-emotion-analysis-review.md.
//
// D1: loadKnownEntities passes approvalStatus: null to skip the approved-only
// default (sentiment runs right after graph extraction, when citations are
// still pending). A falsy coercion in entities.getByDocumentId silently
// re-applied the approved filter, starving the LLM's entity inventory.
//
// D2: retrying a done job (or a failed job whose transcript already has
// annotations) must set reset_existing = 1 so the rerun replaces rather
// than appends.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;
let loadKnownEntities;

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  db = require('../../database/db');
  ({ loadKnownEntities } = require('../../utils/worker-sentiment'));

  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [9300, 'P0 D1 doc']);
  await db.runAsync(
    `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`,
    [9300, 9300, 'Mr. Jessop visited the school house at Cariboo.']
  );
}, 60_000);

async function insertEntityWithCitation({ entityId, name, approvalStatus }) {
  await db.runAsync(
    `INSERT INTO entities (id, entity_type, canonical_name) VALUES (?, 'person', ?)`,
    [entityId, name]
  );
  await db.runAsync(
    `INSERT INTO citations (entity_id, transcript_id, document_id, passage_text,
                            extraction_method, approval_status)
     VALUES (?, ?, ?, ?, 'llm', ?)`,
    [entityId, 9300, 9300, name, approvalStatus]
  );
}

describe('D1 — known-entities inventory includes pending citations', () => {
  beforeAll(async () => {
    await insertEntityWithCitation({ entityId: 9301, name: 'John Jessop', approvalStatus: 'pending' });
    await insertEntityWithCitation({ entityId: 9302, name: 'Cariboo School', approvalStatus: 'approved' });
    await insertEntityWithCitation({ entityId: 9303, name: 'Rejected Ghost', approvalStatus: 'rejected' });
  });

  it('loadKnownEntities returns entities whose only citations are pending', async () => {
    const rows = await loadKnownEntities(9300);
    const ids = rows.map((e) => e.id);
    expect(ids).toContain(9301); // pending-only entity — the D1 regression
    expect(ids).toContain(9302);
    expect(ids).toContain(9303); // null = no approval filter at all
    const jessop = rows.find((e) => e.id === 9301);
    expect(jessop.name).toBe('John Jessop');
    expect(jessop.entity_type).toBe('person');
  });

  it('getByDocumentId still defaults to approved-only when approvalStatus is omitted', async () => {
    const rows = await db.entitiesAsync.getByDocumentId(9300);
    const ids = rows.map((e) => e.id);
    expect(ids).toContain(9302);
    expect(ids).not.toContain(9301);
    expect(ids).not.toContain(9303);
  });

  it('getByDocumentId honors an explicit approvalStatus', async () => {
    const rows = await db.entitiesAsync.getByDocumentId(9300, { approvalStatus: 'pending' });
    expect(rows.map((e) => e.id)).toEqual([9301]);
  });
});

describe('D2 — retry is non-additive when annotations already exist', () => {
  async function createJobWithStatus({ transcriptId, status }) {
    const jobId = await db.sentimentAsync.createJob({
      document_id: 9300,
      transcript_id: transcriptId,
      reset_existing: 0
    });
    await db.runAsync(
      `UPDATE sentiment_extraction_jobs SET status = ? WHERE id = ?`,
      [status, jobId]
    );
    return jobId;
  }

  it('retry of a done job whose transcript has annotations sets reset_existing = 1', async () => {
    const jobId = await createJobWithStatus({ transcriptId: 9300, status: 'done' });
    await db.sentimentAsync.writeAnnotationsForJob(jobId, [{
      transcript_id: 9300, document_id: 9300,
      span_start: 0, span_end: 10, evidence_excerpt: 'Mr. Jessop',
      polarity: 'neutral', intensity: 'low', confidence: 0.7,
      voice_role: 'author', target_kind: 'phrase', target_phrase: 'the visit',
      emotion_phrase_verbatim: 'Mr. Jessop',
      approval_status: 'pending', auto_approved: 0,
      extracted_at: new Date().toISOString()
    }]);

    await db.sentimentAsync.retry(jobId);

    const job = await db.sentimentAsync.getJobById(jobId);
    expect(job.status).toBe('queued');
    expect(job.reset_existing).toBe(1);
  });

  it('retry of a failed job with no prior annotations leaves reset_existing = 0', async () => {
    // Separate transcript so the annotations written above don't leak in.
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [9310, 'P0 D2 doc']);
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`,
      [9310, 9310, 'Nothing extracted yet.']
    );
    const jobId = await createJobWithStatus({ transcriptId: 9310, status: 'failed' });

    await db.sentimentAsync.retry(jobId);

    const job = await db.sentimentAsync.getJobById(jobId);
    expect(job.status).toBe('queued');
    expect(job.reset_existing).toBe(0);
  });

  it('retry of a failed job that wrote annotations before failing sets reset_existing = 1', async () => {
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [9320, 'P0 D2 partial doc']);
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`,
      [9320, 9320, 'Partial write then failure.']
    );
    const jobId = await createJobWithStatus({ transcriptId: 9320, status: 'failed' });
    await db.sentimentAsync.writeAnnotationsForJob(jobId, [{
      transcript_id: 9320, document_id: 9320,
      span_start: 0, span_end: 7, evidence_excerpt: 'Partial',
      polarity: 'neutral', intensity: 'low', confidence: 0.7,
      voice_role: 'author', target_kind: 'phrase', target_phrase: 'the write',
      emotion_phrase_verbatim: 'Partial',
      approval_status: 'pending', auto_approved: 0,
      extracted_at: new Date().toISOString()
    }]);

    await db.sentimentAsync.retry(jobId);

    const job = await db.sentimentAsync.getJobById(jobId);
    expect(job.reset_existing).toBe(1);
  });
});
