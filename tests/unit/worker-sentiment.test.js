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
});
