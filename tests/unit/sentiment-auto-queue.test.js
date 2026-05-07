'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('sentiment auto-queue from extraction completion', () => {
  let db, autoQueueSentimentForTranscript, tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentiment-autoqueue-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    await db.runAsync(`INSERT INTO documents (id, title) VALUES (1, 'D')`);
    await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1, 1, 'x')`);
    await db.runAsync(`INSERT INTO collections (id, name) VALUES (10, 'C-on'), (11, 'C-off')`);
    await db.runAsync(`UPDATE collections SET sentiment_enabled = 1 WHERE id = 10`);
    await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1, 10), (1, 11)`);
    ({ autoQueueSentimentForTranscript } = require('../../utils/worker-extraction'));
  });

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('queues sentiment job when ≥1 collection has sentiment_enabled = 1', async () => {
    await autoQueueSentimentForTranscript({ documentId: 1, transcriptId: 1 });
    const row = await db.getAsync(`SELECT * FROM sentiment_extraction_jobs WHERE transcript_id = 1`);
    expect(row).toBeTruthy();
    expect(row.status).toBe('queued');
  });

  test('does not double-queue if a queued job already exists', async () => {
    await autoQueueSentimentForTranscript({ documentId: 1, transcriptId: 1 });
    await autoQueueSentimentForTranscript({ documentId: 1, transcriptId: 1 });
    const rows = await db.allAsync(`SELECT id FROM sentiment_extraction_jobs WHERE transcript_id = 1`);
    expect(rows.length).toBe(1);
  });

  test('does not queue when no enabled collections', async () => {
    await db.runAsync(`UPDATE collections SET sentiment_enabled = 0 WHERE id = 10`);
    await autoQueueSentimentForTranscript({ documentId: 1, transcriptId: 1 });
    const rows = await db.allAsync(`SELECT id FROM sentiment_extraction_jobs WHERE transcript_id = 1`);
    expect(rows.length).toBe(0);
  });
});
