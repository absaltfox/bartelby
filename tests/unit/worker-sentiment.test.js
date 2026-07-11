'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('worker-sentiment singleton path', () => {
  let db;
  let runSentimentExtractionCycle;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-sentiment-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();

    jest.doMock('../../utils/sentiment/provider', () => ({
      callSingleton: jest.fn(async () => ({
        text: JSON.stringify({
          annotations: [{
            span_start: 0, span_end: 9,
            emotion_phrase_verbatim: 'weariness',
            polarity: 'negative', intensity: 'low',
            voice_role: 'author', target_kind: 'phrase',
            target_phrase: 'state of school',
            confidence: 0.92
          }]
        }),
        usage: { input_tokens: 100, output_tokens: 30 }
      })),
      submitBatch: jest.fn(),
      getBatchStatus: jest.fn(),
      fetchBatchResults: jest.fn()
    }));

    jest.doMock('../../utils/sentiment/embed', () => ({
      embedTexts: jest.fn(async (texts) => texts.map(() => new Array(384).fill(0.0))),
      EMBED_MODEL_ID: 'Xenova/all-MiniLM-L6-v2'
    }));

    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    await db.runAsync(`INSERT INTO documents (id, title) VALUES (1, 'Doc')`);
    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1, 1, 'weariness was the order of the day at the school')`);
    await db.runAsync(`INSERT INTO settings (key, value) VALUES ('sentiment.prompt.default', 'JSON annotations: {{transcript_content}} entities: {{known_entities}} meta: {{document_metadata}}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    await db.runAsync(`INSERT INTO settings (key, value) VALUES ('sentiment.provider.default', 'claude') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

    ({ runSentimentExtractionCycle } = require('../../utils/worker-sentiment'));
  });

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('singleton: claims one job, writes one annotation, marks done', async () => {
    const jobId = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    await runSentimentExtractionCycle();
    const job = await db.sentimentAsync.getJobById(jobId);
    expect(job.status).toBe('done');
    expect(job.input_tokens).toBe(100);
    expect(job.output_tokens).toBe(30);
    const rows = await db.sentimentAsync.getAnnotationsByJobId(jobId);
    expect(rows.length).toBe(1);
    expect(rows[0].polarity).toBe('negative');
    expect(rows[0].auto_approved).toBe(1);
  });

  test('singleton: persists per-annotation notes and per-job extraction_notes', async () => {
    const provider = require('../../utils/sentiment/provider');
    provider.callSingleton.mockResolvedValueOnce({
      text: JSON.stringify({
        document_notes: 'Mostly procedural; one strong negative move around the schoolhouse.',
        annotations: [{
          span_start: 0, span_end: 9,
          emotion_phrase_verbatim: 'weariness',
          polarity: 'negative', intensity: 'low',
          voice_role: 'author', target_kind: 'phrase',
          target_phrase: 'state of school',
          confidence: 0.92,
          notes: 'Direct negative; "weariness" is unambiguous period vocab.'
        }]
      }),
      usage: { input_tokens: 100, output_tokens: 30 }
    });

    const jobId = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    await runSentimentExtractionCycle();

    const job = await db.sentimentAsync.getJobById(jobId);
    expect(job.extraction_notes).toMatch(/one strong negative move/);

    const rows = await db.sentimentAsync.getAnnotationsByJobId(jobId);
    expect(rows[0].notes).toMatch(/unambiguous period vocab/);
  });

  test('singleton: reset_existing deletes prior annotations after successful write', async () => {
    const jobId1 = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    await runSentimentExtractionCycle();
    const beforeCount = (await db.sentimentAsync.getAnnotationsByJobId(jobId1)).length;
    expect(beforeCount).toBe(1);

    await db.runAsync(
      `INSERT INTO sentiment_extraction_jobs (document_id, transcript_id, reset_existing, status, kind)
       VALUES (1, 1, 1, 'queued', 'singleton')`
    );
    await runSentimentExtractionCycle();
    const allRows = await db.allAsync(`SELECT extraction_job_id FROM sentiment_annotations WHERE transcript_id = 1`);
    expect(allRows.length).toBe(1);
    expect(allRows[0].extraction_job_id).not.toBe(jobId1);
  });

  test('batch (two-phase): pre-stages with pending-* correlation, then atomically flips on provider success', async () => {
    const provider = require('../../utils/sentiment/provider');
    provider.submitBatch.mockImplementationOnce(async ({ runtimeConfig }) => {
      // At this point, jobs should be in pending-* state
      const rows = await db.allAsync(
        `SELECT id, status, batch_remote_id, submitted_prompt
           FROM sentiment_extraction_jobs WHERE status = 'running' AND kind = 'batch'`
      );
      expect(rows.length).toBe(2);
      expect(rows[0].batch_remote_id).toMatch(/^pending-/);
      expect(rows[0].submitted_prompt).toBeTruthy();  // pre-stage populated this
      expect(rows[0].batch_remote_id).toBe(rows[1].batch_remote_id);  // same correlation
      // Return a real provider batch id
      return { batch_id: 'remote-1', provider: 'anthropic', model_name: 'claude-3-5-haiku-latest' };
    });

    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (2, 1, 'weariness elsewhere too')`);
    const j1 = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    const j2 = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 2 });

    await runSentimentExtractionCycle();

    const r1 = await db.sentimentAsync.getJobById(j1);
    const r2 = await db.sentimentAsync.getJobById(j2);
    expect(r1.status).toBe('batch_submitted');
    expect(r2.status).toBe('batch_submitted');
    expect(r1.batch_remote_id).toBe('remote-1');  // not pending- anymore
    expect(r2.batch_remote_id).toBe('remote-1');
    expect(r1.model_name).toBe('claude-3-5-haiku-latest');
    expect(r1.submitted_prompt).toBeTruthy();
    expect(r1.prompt_template_hash).toBeTruthy();  // SHA-256 of template
  });

  test('batch: unconfigured sentiment.provider.default fails jobs with actionable message before pre-staging', async () => {
    const provider = require('../../utils/sentiment/provider');
    // Mirror the seeded-empty prod default (database/db.js sentiment settings seed).
    await db.runAsync(`UPDATE settings SET value = '' WHERE key = 'sentiment.provider.default'`);

    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (2, 1, 'weariness too')`);
    const j1 = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    const j2 = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 2 });

    await runSentimentExtractionCycle();

    const r1 = await db.sentimentAsync.getJobById(j1);
    const r2 = await db.sentimentAsync.getJobById(j2);
    expect(r1.status).toBe('failed');
    expect(r2.status).toBe('failed');
    expect(r1.error).toMatch(/sentiment\.provider\.default/);
    expect(r1.batch_remote_id).toBeNull();      // never pre-staged
    expect(provider.submitBatch).not.toHaveBeenCalled();
  });

  test('batch: provider call failure marks all correlation rows as failed and clears placeholder', async () => {
    const provider = require('../../utils/sentiment/provider');
    provider.submitBatch.mockRejectedValueOnce(new Error('Provider 503 Service Unavailable'));

    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (2, 1, 'weariness too')`);
    const j1 = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    const j2 = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 2 });

    await runSentimentExtractionCycle();

    const r1 = await db.sentimentAsync.getJobById(j1);
    const r2 = await db.sentimentAsync.getJobById(j2);
    expect(r1.status).toBe('failed');
    expect(r2.status).toBe('failed');
    expect(r1.batch_remote_id).toBeNull();   // placeholder cleared
    expect(r1.error).toMatch(/503/);
  });

  test('batch finalization: claims durably, materializes per-job results, marks done', async () => {
    const provider = require('../../utils/sentiment/provider');
    provider.submitBatch.mockResolvedValueOnce({ batch_id: 'remote-2', provider: 'anthropic' });

    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (3, 1, 'weariness here')`);
    const jA = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    const jB = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 3 });
    await runSentimentExtractionCycle();

    provider.getBatchStatus.mockResolvedValueOnce({ status: 'completed' });
    provider.fetchBatchResults.mockResolvedValueOnce([
      { request_id: String(jA), text: JSON.stringify({ annotations: [{
        span_start: 0, span_end: 9, emotion_phrase_verbatim: 'weariness',
        polarity: 'negative', intensity: 'low', voice_role: 'author',
        target_kind: 'phrase', target_phrase: 'school', confidence: 0.91
      }]}), usage: { input_tokens: 50, output_tokens: 12 } },
      { request_id: String(jB), text: JSON.stringify({ annotations: [{
        span_start: 0, span_end: 9, emotion_phrase_verbatim: 'weariness',
        polarity: 'negative', intensity: 'low', voice_role: 'author',
        target_kind: 'phrase', target_phrase: 'school', confidence: 0.66
      }]}), usage: { input_tokens: 40, output_tokens: 10 } }
    ]);

    const { pollRunningSentimentBatches } = require('../../utils/worker-sentiment');
    await pollRunningSentimentBatches();

    const a = await db.sentimentAsync.getJobById(jA);
    const b = await db.sentimentAsync.getJobById(jB);
    expect(a.status).toBe('done');
    expect(b.status).toBe('done');
    const annA = await db.sentimentAsync.getAnnotationsByJobId(jA);
    const annB = await db.sentimentAsync.getAnnotationsByJobId(jB);
    expect(annA.length).toBe(1);
    expect(annA[0].auto_approved).toBe(1);
    expect(annB[0].approval_status).toBe('pending');
  });

  test('resolves phrases in one batch when multiple annotations share the same emotion phrase', async () => {
  // Override the seeded transcript to contain content covering both phrases at known spans.
  // "weariness weariness joy text" → 0–9 = 'weariness', 10–19 = 'weariness', 20–23 = 'joy'.
  await db.runAsync(
    `UPDATE transcripts SET content = ? WHERE id = 1`,
    ['weariness weariness joy text']
  );

  // Override the singleton mock to return 3 annotations with 2 duplicate phrases
  const provider = require('../../utils/sentiment/provider');
  provider.callSingleton.mockResolvedValueOnce({
    text: JSON.stringify({
      annotations: [
        { span_start: 0, span_end: 9, emotion_phrase_verbatim: 'weariness',
          polarity: 'negative', intensity: 'low', voice_role: 'author',
          target_kind: 'phrase', target_phrase: 'weariness', confidence: 0.92 },
        { span_start: 10, span_end: 19, emotion_phrase_verbatim: 'weariness',
          polarity: 'negative', intensity: 'low', voice_role: 'author',
          target_kind: 'phrase', target_phrase: 'weariness', confidence: 0.92 },
        { span_start: 20, span_end: 23, emotion_phrase_verbatim: 'joy',
          polarity: 'positive', intensity: 'moderate', voice_role: 'author',
          target_kind: 'phrase', target_phrase: 'joy', confidence: 0.92 }
      ]
    }),
    usage: { input_tokens: 100, output_tokens: 30 }
  });

  const jobId = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
  await runSentimentExtractionCycle();

  // Verify the job completed (not stalled or failed by parse/validate)
  const job = await db.sentimentAsync.getJobById(jobId);
  expect(job.status).toBe('done');

  // 3 annotations written, only 2 unique phrase IDs across them
  const annRows = await db.sentimentAsync.getAnnotationsByJobId(jobId);
  expect(annRows).toHaveLength(3);
  const uniquePhraseIds = new Set(annRows.map((r) => r.emotion_phrase_id));
  expect(uniquePhraseIds.size).toBe(2);

  // usage_count for 'weariness' should be 1 (per-call), NOT 2 (per-annotation)
  const wearinessRow = await db.getAsync(
    `SELECT usage_count FROM sentiment_emotion_phrases WHERE phrase_text_normalized = ?`,
    ['weariness']
  );
  expect(wearinessRow.usage_count).toBe(1);

  // embedTexts called once with both unique phrases
  const embed = require('../../utils/sentiment/embed');
  expect(embed.embedTexts).toHaveBeenCalledTimes(1);
  expect(embed.embedTexts.mock.calls[0][0].sort()).toEqual(['joy', 'weariness']);
});

  test('batch finalization: per-row result.error marks job failed (not done)', async () => {
    const provider = require('../../utils/sentiment/provider');
    provider.submitBatch.mockResolvedValueOnce({ batch_id: 'remote-err', provider: 'vertex' });

    // Two jobs to clear the singleton/batch threshold; we'll only fail one.
    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (4, 1, 'extra content for err test')`);
    const jFail = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    const jOk = await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 4 });
    await runSentimentExtractionCycle();

    provider.getBatchStatus.mockResolvedValueOnce({ status: 'completed' });
    // jFail returns a per-row error (Vertex proto rejection shape). jOk
    // returns a normal result. The worker must mark jFail `failed` rather
    // than running parseAndValidate on empty text and silently marking it
    // `done`.
    provider.fetchBatchResults.mockResolvedValueOnce([
      { request_id: String(jFail), text: '', error: "no such field: 'metadata'" },
      { request_id: String(jOk), text: JSON.stringify({ annotations: [{
        span_start: 0, span_end: 9, emotion_phrase_verbatim: 'extra con',
        polarity: 'negative', intensity: 'low', voice_role: 'author',
        target_kind: 'phrase', target_phrase: 'content', confidence: 0.9
      }]}), usage: { input_tokens: 10, output_tokens: 5 } }
    ]);

    const { pollRunningSentimentBatches } = require('../../utils/worker-sentiment');
    await pollRunningSentimentBatches();

    const failed = await db.sentimentAsync.getJobById(jFail);
    const ok = await db.sentimentAsync.getJobById(jOk);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/no such field/);
    expect(ok.status).toBe('done');
    expect((await db.sentimentAsync.getAnnotationsByJobId(jFail)).length).toBe(0);
    expect((await db.sentimentAsync.getAnnotationsByJobId(jOk)).length).toBe(1);
  });
});
