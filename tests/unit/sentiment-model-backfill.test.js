'use strict';

describe('sentimentAsync.listBackfillCandidatesForCollection', () => {
  let db;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
    process.env.DATABASE_DRIVER = 'sqljs';
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    process.env.NODE_ENV = 'test';

    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema();
  });

  async function makeCollection(name) {
    return db.collectionsAsync.create({ name, createdBy: null });
  }

  async function makeDoc(title, collectionId) {
    const docId = (await db.runAsync(
      `INSERT INTO documents (title) VALUES (?)`,
      [title]
    )).lastInsertRowid;
    await db.runAsync(
      `INSERT INTO document_collections (document_id, collection_id) VALUES (?, ?)`,
      [docId, collectionId]
    );
    return docId;
  }

  async function makeTranscript(docId, { isBest = 1 } = {}) {
    return (await db.runAsync(
      `INSERT INTO transcripts (document_id, content, is_best) VALUES (?, ?, ?)`,
      [docId, 'sample', isBest]
    )).lastInsertRowid;
  }

  test('returns best transcripts in collection with no prior sentiment job', async () => {
    const collectionId = await makeCollection('backfill-empty-collection');
    const docId = await makeDoc('backfill-doc-1', collectionId);
    const transcriptId = await makeTranscript(docId);

    const rows = await db.sentimentAsync.listBackfillCandidatesForCollection(collectionId);
    expect(rows.map((r) => r.transcript_id)).toEqual([transcriptId]);
    expect(rows[0].document_id).toBe(docId);
  });

  test('skips transcripts that already have a queued sentiment job', async () => {
    const collectionId = await makeCollection('backfill-with-queued');
    const docId = await makeDoc('backfill-doc-2', collectionId);
    const transcriptId = await makeTranscript(docId);
    await db.sentimentAsync.createJob({ document_id: docId, transcript_id: transcriptId });

    const rows = await db.sentimentAsync.listBackfillCandidatesForCollection(collectionId);
    expect(rows).toEqual([]);
  });

  test('skips non-best transcripts', async () => {
    const collectionId = await makeCollection('backfill-non-best');
    const docId = await makeDoc('backfill-doc-3', collectionId);
    await makeTranscript(docId, { isBest: 0 });

    const rows = await db.sentimentAsync.listBackfillCandidatesForCollection(collectionId);
    expect(rows).toEqual([]);
  });
});
