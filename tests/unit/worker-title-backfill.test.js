'use strict';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let db;
let runTitleBackfillCycle;

beforeEach(async () => {
  jest.resetModules();
  jest.doMock('../../utils/llm', () => ({
    generateDocumentTitle: jest.fn(async (provider, text) => {
      if (/FAILDOC/.test(text)) throw new Error('model not found');
      return { title: 'Regenerated Title', usage: { inputTokens: 5, outputTokens: 2 } };
    }),
    generateDocumentSummary: jest.fn(async () => ({ summary: 'Regenerated summary.', usage: { inputTokens: 7, outputTokens: 3 } }))
  }));
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
  await db.runAsync(`INSERT INTO collections (id, name) VALUES (1, 'Coll')`);
  await db.runAsync(`INSERT INTO settings (key, value) VALUES ('default_provider', 'vertex')
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  // doc 1: generic title, no description -> both regenerated
  // doc 2: real title, has description   -> skipped entirely
  // doc 3: generic title, transcript triggers title failure
  await db.runAsync(`INSERT INTO documents (id, title, description) VALUES
    (1, 'Page 1170', NULL),
    (2, 'A Fine Letter', 'Existing description'),
    (3, 'Page 3', 'has description')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content, is_best) VALUES
    (1, 1, 'transcript one', 1),
    (2, 2, 'transcript two', 1),
    (3, 3, 'FAILDOC transcript', 1)`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1,1),(2,1),(3,1)`);
  ({ runTitleBackfillCycle } = require('../../utils/worker-title-backfill'));
});

afterEach(async () => {
  if (db && db.closeAsync) await db.closeAsync();
});

describe('title backfill worker', () => {
  it('regenerates generic titles + missing summaries, skips fixed docs, fails job when any doc failed', async () => {
    const jobId = await db.titleBackfillJobsAsync.create({ collection_id: 1 });
    await runTitleBackfillCycle();

    const doc1 = await db.getAsync('SELECT title, description FROM documents WHERE id = 1');
    expect(doc1.title).toBe('Regenerated Title');
    expect(doc1.description).toBe('Regenerated summary.');

    const doc2 = await db.getAsync('SELECT title, description FROM documents WHERE id = 2');
    expect(doc2.title).toBe('A Fine Letter');
    expect(doc2.description).toBe('Existing description');

    const doc3 = await db.getAsync('SELECT title FROM documents WHERE id = 3');
    expect(doc3.title).toBe('Page 3'); // title failed, unchanged

    const job = await db.titleBackfillJobsAsync.getById(jobId);
    expect(job.status).toBe('failed'); // one doc failed
    expect(job.docs_total).toBe(3);
    expect(job.docs_processed).toBe(3);
    expect(job.titles_updated).toBe(1);
    expect(job.summaries_updated).toBe(1);
    expect(job.docs_failed).toBe(1);
    expect(job.error).toMatch(/1 of 3 documents failed/);
    expect(job.provider).toBe('vertex');
    expect(job.log).toMatch(/Title generation failed for document 3/);
  });

  it('completes done when nothing fails, and is idempotent on re-run', async () => {
    await db.runAsync(`UPDATE transcripts SET content = 'ok transcript' WHERE id = 3`);
    const jobId = await db.titleBackfillJobsAsync.create({ collection_id: 1 });
    await runTitleBackfillCycle();
    expect((await db.titleBackfillJobsAsync.getById(jobId)).status).toBe('done');

    // Re-run: all titles now real, descriptions filled -> zero LLM calls
    const llm = require('../../utils/llm');
    llm.generateDocumentTitle.mockClear();
    llm.generateDocumentSummary.mockClear();
    const jobId2 = await db.titleBackfillJobsAsync.create({ collection_id: 1 });
    await runTitleBackfillCycle();
    expect((await db.titleBackfillJobsAsync.getById(jobId2)).status).toBe('done');
    expect(llm.generateDocumentTitle).not.toHaveBeenCalled();
    expect(llm.generateDocumentSummary).not.toHaveBeenCalled();
  });

  it('fails the job with actionable guidance when default_provider is unset', async () => {
    await db.runAsync(`UPDATE settings SET value = '' WHERE key = 'default_provider'`);
    const jobId = await db.titleBackfillJobsAsync.create({ collection_id: 1 });
    await runTitleBackfillCycle();
    const job = await db.titleBackfillJobsAsync.getById(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/default_provider/);
  });
});
