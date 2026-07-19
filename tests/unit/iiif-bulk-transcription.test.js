'use strict';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

// feat/iiif-ingestion Phase 1d — the admin "Transcribe N new documents" action.
// Selects a collection's IIIF documents that lack an LLM transcript and enqueues
// transcription: one batch job when the provider supports batch and the count
// clears the threshold, else N single jobs. Idempotent: docs with an existing
// LLM transcript or an active job are skipped. Plan "Locked decision 2026-07-15b".

let db;
let enqueueIiifCollectionTranscription;

async function makeIiifDoc(title, pages) {
  const [primary, ...rest] = pages;
  const metadata = { document_type: 'letter', iiif_source_id: 1 };
  if (rest.length) metadata.additional_pages = rest;
  const id = await db.documentsAsync.create({
    title, date_created: null, description: null, image_path: primary, metadata
  });
  await db.documentCollectionsAsync.add(id, 1);
  return id;
}

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
  await db.runAsync(`INSERT INTO collections (id, name) VALUES (1, 'Coll')`);
  ({ enqueueIiifCollectionTranscription } = require('../../utils/iiif-bulk-transcription'));
}, 60_000);

describe('enqueueIiifCollectionTranscription', () => {
  let docA, docB, docWithLlm;

  beforeAll(async () => {
    docA = await makeIiifDoc('A', ['https://iiif.test/a0/full/2000,/0/default.jpg', 'https://iiif.test/a1/full/2000,/0/default.jpg']);
    docB = await makeIiifDoc('B', ['https://iiif.test/b0/full/2000,/0/default.jpg']);
    // A doc that already has an LLM transcript (provider set) — must be skipped.
    docWithLlm = await makeIiifDoc('C', ['https://iiif.test/c0/full/2000,/0/default.jpg']);
    await db.transcriptsAsync.create({
      document_id: docWithLlm, content: 'llm text', transcriber: 'ai', notes: null, provider: 'openai', is_best: 1
    });
    // docA also has a UBC FullText transcript (provider NULL) — should NOT count
    // as an LLM transcript, so docA still needs transcription.
    await db.transcriptsAsync.create({
      document_id: docA, content: 'ubc fulltext', transcriber: 'UBC Open Collections FullText', notes: null, is_best: 1
    });
  });

  it('enqueues N single jobs when batching is not selected', async () => {
    const result = await enqueueIiifCollectionTranscription({
      collectionId: 1, provider: 'openai', requestedByUserId: 1, allowBatch: false
    }, { supportsBatchProvider: () => true });

    expect(result.mode).toBe('single');
    expect(result.documentCount).toBe(2); // docA + docB; docWithLlm excluded
    expect(result.jobIds).toHaveLength(2);

    const jobs = await db.allAsync(`SELECT * FROM transcription_jobs ORDER BY id ASC`);
    expect(jobs.length).toBe(2);
    expect(jobs.every((j) => j.job_kind === 'single')).toBe(true);
    // docA's second page is carried as additional_image_paths.
    const jobA = jobs.find((j) => j.document_id === docA);
    expect(JSON.parse(jobA.additional_image_paths)).toEqual(['https://iiif.test/a1/full/2000,/0/default.jpg']);
  });

  it('is idempotent: a second call finds nothing to enqueue (active jobs skipped)', async () => {
    const result = await enqueueIiifCollectionTranscription({
      collectionId: 1, provider: 'openai', requestedByUserId: 1, allowBatch: false
    }, { supportsBatchProvider: () => true });
    expect(result.mode).toBe('none');
    expect(result.documentCount).toBe(0);
  });
});

describe('enqueueIiifCollectionTranscription — batch mode', () => {
  let ids;

  beforeAll(async () => {
    await db.runAsync(`INSERT INTO collections (id, name) VALUES (2, 'BatchColl')`);
    ids = [];
    for (let i = 0; i < 3; i++) {
      const id = await db.documentsAsync.create({
        title: `Batch ${i}`, date_created: null, description: null,
        image_path: `https://iiif.test/batch${i}/full/2000,/0/default.jpg`,
        metadata: { iiif_source_id: 2 }
      });
      await db.documentCollectionsAsync.add(id, 2);
      ids.push(id);
    }
  });

  it('creates ONE batch job over all eligible docs when the provider supports batch and count clears the threshold', async () => {
    const result = await enqueueIiifCollectionTranscription({
      collectionId: 2, provider: 'openai', requestedByUserId: 1, allowBatch: true, batchThreshold: 2
    }, { supportsBatchProvider: (p) => p === 'openai' });

    expect(result.mode).toBe('batch');
    expect(result.documentCount).toBe(3);
    expect(result.pageCount).toBe(3);

    const jobs = await db.allAsync(`SELECT * FROM transcription_jobs WHERE job_kind = 'batch'`);
    expect(jobs.length).toBe(1);
    const manifest = JSON.parse(jobs[0].batch_manifest);
    expect(manifest.requests).toHaveLength(3);
    expect(manifest.requests[0].imagePath).toMatch(/^https:\/\/iiif\.test\/batch0/);
    expect(jobs[0].batch_document_count).toBe(3);
  });
});
