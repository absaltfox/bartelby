'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('sentiment model', () => {
  let db;
  let sentimentAsync;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentiment-model-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    sentimentAsync = db.sentimentAsync;
    await db.runAsync(`INSERT INTO documents (id, title) VALUES (1, 'Doc A')`);
    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1, 1, 'transcript text')`);
  });

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('createJob inserts a queued singleton job', async () => {
    const id = await sentimentAsync.createJob({
      document_id: 1, transcript_id: 1, reset_existing: 0
    });
    const row = await sentimentAsync.getJobById(id);
    expect(row.status).toBe('queued');
    expect(row.kind).toBe('singleton');
    expect(row.transcript_id).toBe(1);
  });

  test('claimNextQueued atomically promotes one job to running', async () => {
    const id = await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 });
    const claimed = await sentimentAsync.claimNextQueued();
    expect(claimed.id).toBe(id);
    expect(claimed.status).toBe('running');
    expect(claimed.kind).toBe('singleton');
    const second = await sentimentAsync.claimNextQueued();
    expect(second).toBeNull();
  });

  test('claimUpToBatch claims up to N queued jobs and marks them batch/running', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 }));
    }
    const claimed = await sentimentAsync.claimUpToBatch(50);
    expect(claimed.length).toBe(3);
    for (const job of claimed) {
      expect(job.status).toBe('running');
      expect(job.kind).toBe('batch');
    }
  });

  test('hasQueuedOrRunningForTranscript returns true when a queued job exists', async () => {
    await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 });
    const has = await sentimentAsync.hasQueuedOrRunningForTranscript(1);
    expect(has).toBe(true);
  });

  test('upsertEmotionPhrase dedupes by normalized text and bumps usage_count', async () => {
    const a = await sentimentAsync.upsertEmotionPhrase('Filled with Deep Indignation.');
    const b = await sentimentAsync.upsertEmotionPhrase('filled with deep indignation');
    expect(a.id).toBe(b.id);
    expect(b.usage_count).toBeGreaterThanOrEqual(2);
  });

  test('writeAnnotationsForJob inserts annotations and links to job', async () => {
    const jobId = await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 });
    const phrase = await sentimentAsync.upsertEmotionPhrase('weariness');
    const written = await sentimentAsync.writeAnnotationsForJob(jobId, [{
      transcript_id: 1, document_id: 1, span_start: 0, span_end: 9,
      evidence_excerpt: 'transcript', polarity: 'negative', intensity: 'low',
      confidence: 0.9, voice_role: 'author', target_kind: 'phrase',
      target_phrase: 'weariness', emotion_phrase_id: phrase.id,
      emotion_phrase_verbatim: 'weariness',
      approval_status: 'approved', auto_approved: 1,
      extracted_by: 'test', extracted_at: new Date().toISOString()
    }]);
    expect(written).toBe(1);
    const rows = await sentimentAsync.getAnnotationsByJobId(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].extraction_job_id).toBe(jobId);
  });

  test('markDone persists extraction_notes', async () => {
    const jobId = await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 });
    await sentimentAsync.markDone(jobId, {
      input_tokens: 1000,
      output_tokens: 100,
      validation_drops: { malformed_json: 0 },
      extraction_notes: 'Highly formal letter; three clear emotional moves around schoolhouse condition.'
    });
    const row = await sentimentAsync.getJobById(jobId);
    expect(row.status).toBe('done');
    expect(row.extraction_notes).toMatch(/three clear emotional moves/);
  });

  test('writeAnnotationsForJob persists per-annotation notes', async () => {
    const jobId = await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 });
    const phrase = await sentimentAsync.upsertEmotionPhrase('weariness');
    await sentimentAsync.writeAnnotationsForJob(jobId, [{
      transcript_id: 1, document_id: 1, span_start: 0, span_end: 9,
      evidence_excerpt: 'transcript', polarity: 'negative', intensity: 'low',
      confidence: 0.9, voice_role: 'author', target_kind: 'phrase',
      target_phrase: 'weariness', emotion_phrase_id: phrase.id,
      emotion_phrase_verbatim: 'weariness',
      notes: 'Direct negative evaluation; "weariness" is unambiguous period vocab.',
      approval_status: 'approved', auto_approved: 1,
      extracted_by: 'test', extracted_at: new Date().toISOString()
    }]);
    const rows = await sentimentAsync.getAnnotationsByJobId(jobId);
    expect(rows[0].notes).toMatch(/unambiguous period vocab/);
  });

  test('markBatchPending: stages a single job with correlation id + submitted_prompt', async () => {
    const jobId = await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 });
    await db.runAsync(`UPDATE sentiment_extraction_jobs SET status = 'running', kind = 'batch' WHERE id = ?`, [jobId]);
    const correlationId = 'pending-test-uuid-1';

    await sentimentAsync.markBatchPending([jobId], correlationId, {
      submitted_prompt: 'rendered prompt text for this job'
    });

    const row = await sentimentAsync.getJobById(jobId);
    expect(row.batch_remote_id).toBe(correlationId);
    expect(row.submitted_prompt).toBe('rendered prompt text for this job');
    expect(row.batch_submitted_at).toBeTruthy();
    expect(row.status).toBe('running');  // still running until phase 3
  });

  test('markBatchSubmittedByCorrelation: atomically flips all rows sharing correlation to batch_submitted', async () => {
    const j1 = await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 });
    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (2, 1, 'second')`);
    const j2 = await sentimentAsync.createJob({ document_id: 1, transcript_id: 2, reset_existing: 0 });
    await db.runAsync(`UPDATE sentiment_extraction_jobs SET status = 'running', kind = 'batch' WHERE id IN (?, ?)`, [j1, j2]);

    const correlationId = 'pending-test-uuid-2';
    await sentimentAsync.markBatchPending([j1], correlationId, { submitted_prompt: 'p1' });
    await sentimentAsync.markBatchPending([j2], correlationId, { submitted_prompt: 'p2' });

    await sentimentAsync.markBatchSubmittedByCorrelation(correlationId, {
      batch_remote_id: 'remote-actual-id',
      provider: 'vertex',
      model_name: 'gemini-3.1-flash-lite-preview',
      prompt_template_hash: 'abc123',
      temperature: 0,
      system_prompt: null
    });

    const r1 = await sentimentAsync.getJobById(j1);
    const r2 = await sentimentAsync.getJobById(j2);
    expect(r1.status).toBe('batch_submitted');
    expect(r2.status).toBe('batch_submitted');
    expect(r1.batch_remote_id).toBe('remote-actual-id');
    expect(r2.batch_remote_id).toBe('remote-actual-id');
    expect(r1.model_name).toBe('gemini-3.1-flash-lite-preview');
    expect(r1.prompt_template_hash).toBe('abc123');
    expect(r1.temperature).toBe(0);
    expect(r1.submitted_prompt).toBe('p1');  // preserved from pre-stage
    expect(r2.submitted_prompt).toBe('p2');
  });

  test('markBatchSubmissionFailed: marks all rows in correlation failed and clears placeholder', async () => {
    const j1 = await sentimentAsync.createJob({ document_id: 1, transcript_id: 1, reset_existing: 0 });
    await db.runAsync(`UPDATE sentiment_extraction_jobs SET status = 'running', kind = 'batch' WHERE id = ?`, [j1]);

    const correlationId = 'pending-test-uuid-3';
    await sentimentAsync.markBatchPending([j1], correlationId, { submitted_prompt: 'p1' });

    await sentimentAsync.markBatchSubmissionFailed(correlationId, 'Vertex API returned 500');

    const r = await sentimentAsync.getJobById(j1);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Vertex API returned 500/);
    expect(r.batch_remote_id).toBeNull();
    expect(r.completed_at).toBeTruthy();
  });

  test('markBatchPending persists provider at placeholder-write time', async () => {
    const jobId = await sentimentAsync.createJob({
      document_id: 1, transcript_id: 1
    });
    // Promote to the state markBatchPending requires (status='running', kind='batch')
    await db.runAsync(
      `UPDATE sentiment_extraction_jobs SET status='running', kind='batch' WHERE id=?`,
      [jobId]
    );
    await sentimentAsync.markBatchPending(
      [jobId], 'pending-corr-1',
      { submitted_prompt: 'p', provider: 'vertex' }
    );
    const row = await db.getAsync(
      `SELECT provider, batch_remote_id FROM sentiment_extraction_jobs WHERE id=?`,
      [jobId]
    );
    expect(row.provider).toBe('vertex');
    expect(row.batch_remote_id).toBe('pending-corr-1');
  });
});
