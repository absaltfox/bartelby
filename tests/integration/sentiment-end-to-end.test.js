'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('sentiment end-to-end (singleton + review queue)', () => {
  let db, runSentimentExtractionCycle, tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentiment-e2e-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();

    jest.doMock('../../utils/sentiment/provider', () => ({
      callSingleton: jest.fn(async () => ({
        text: JSON.stringify({ annotations: [
          { span_start: 0, span_end: 9, emotion_phrase_verbatim: 'weariness',
            polarity: 'negative', intensity: 'low', voice_role: 'author',
            target_kind: 'phrase', target_phrase: 'school', confidence: 0.91 },
          { span_start: 0, span_end: 9, emotion_phrase_verbatim: 'weariness',
            polarity: 'negative', intensity: 'low', voice_role: 'author',
            target_kind: 'phrase', target_phrase: 'school', confidence: 0.70 }
        ]}),
        usage: { input_tokens: 100, output_tokens: 30 }
      })),
      submitBatch: jest.fn(),
      getBatchStatus: jest.fn(),
      fetchBatchResults: jest.fn()
    }));
    jest.doMock('../../utils/sentiment/embed', () => ({
      embedTexts: jest.fn(async (t) => t.map(() => new Array(384).fill(0))),
      EMBED_MODEL_ID: 'Xenova/all-MiniLM-L6-v2'
    }));

    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    await db.runAsync(`INSERT INTO documents (id, title) VALUES (1, 'Doc')`);
    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1, 1, 'weariness in the school today')`);
    await db.runAsync(`INSERT INTO settings (key, value) VALUES ('sentiment.prompt.default', 'JSON annotations: {{transcript_content}} entities: {{known_entities}} meta: {{document_metadata}}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    await db.runAsync(`INSERT INTO settings (key, value) VALUES ('sentiment.provider.default', 'claude') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

    ({ runSentimentExtractionCycle } = require('../../utils/worker-sentiment'));
  });

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('one job → 1 auto-approved + 1 pending; pending shows up in listPendingAnnotations', async () => {
    await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    await runSentimentExtractionCycle();
    const all = await db.allAsync(`SELECT approval_status, auto_approved FROM sentiment_annotations`);
    expect(all.length).toBe(2);
    expect(all.filter((r) => r.approval_status === 'approved').length).toBe(1);
    expect(all.filter((r) => r.approval_status === 'pending').length).toBe(1);

    const pending = await db.sentimentAsync.listPendingAnnotations({ limit: 25 });
    expect(pending.length).toBe(1);
  });

  test('reset_existing rerun replaces all annotations for the transcript', async () => {
    await db.sentimentAsync.createJob({ document_id: 1, transcript_id: 1 });
    await runSentimentExtractionCycle();
    const beforeIds = (await db.allAsync(`SELECT id FROM sentiment_annotations WHERE transcript_id = 1`)).map((r) => r.id);

    await db.runAsync(
      `INSERT INTO sentiment_extraction_jobs (document_id, transcript_id, reset_existing, status, kind)
       VALUES (1, 1, 1, 'queued', 'singleton')`
    );
    await runSentimentExtractionCycle();

    const afterIds = (await db.allAsync(`SELECT id FROM sentiment_annotations WHERE transcript_id = 1`)).map((r) => r.id);
    expect(afterIds.length).toBe(2);
    expect(afterIds.some((id) => beforeIds.includes(id))).toBe(false);
  });
});
