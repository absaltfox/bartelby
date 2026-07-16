'use strict';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

// feat/iiif-ingestion Phase 1d — the IIIF sync worker turns an enumerated
// source into one pure-reference document per manifest (canvases = pages), with
// UBC FullText written as the is_best transcript. Downstream LLM transcription
// is a SEPARATE admin-triggered step (the batch-capable button), so this worker
// never enqueues transcription. See plan "Locked decision (2026-07-15b)".

let db;
let runIiifSyncCycle;

// A fake adapter standing in for utils/iiif/sources/ubc-oc.js. Two items: a
// 2-canvas letter with FullText, and a 1-canvas letter without.
function makeFakeAdapter() {
  return {
    async *enumerateManifestRefs() {
      yield { manifestUrl: 'https://iiif.test/m/A/manifest', itemId: '1.0001', title: 'Letter A', fullText: null, offset: 0 };
      yield { manifestUrl: 'https://iiif.test/m/B/manifest', itemId: '1.0002', title: null, fullText: null, offset: 0 };
    },
    buildItemImageUrl(coll, itemId, canvasIndex, size) {
      const dashed = String(itemId).replace(/\./g, '-');
      return `https://iiif.test/image/cdm.${coll}.${dashed}.${String(canvasIndex).padStart(4, '0')}/full/${size}/0/default.jpg`;
    },
    buildItemImageServiceBase(coll, itemId, canvasIndex) {
      const dashed = String(itemId).replace(/\./g, '-');
      return `https://iiif.test/image/cdm.${coll}.${dashed}.${String(canvasIndex).padStart(4, '0')}`;
    },
    async fetchItemFullText(source, itemId) {
      return itemId === '1.0001' ? 'Dear friend,\nyours truly.' : null;
    }
  };
}

// Fake manifest fetch: item A has 2 canvases, item B has 1.
async function fakeFetchJson(url) {
  const canvasCount = url.includes('/A/') ? 2 : 1;
  return {
    '@context': 'http://iiif.io/api/presentation/2/context.json',
    '@id': url,
    label: url.includes('/A/') ? 'Manifest A' : 'Manifest B',
    sequences: [{
      canvases: Array.from({ length: canvasCount }, (_, i) => ({
        '@id': `${url}/canvas/${i}`,
        images: [{ resource: { service: { '@id': `https://broken.ubc/service.${i}.0000` } } }]
      }))
    }]
  };
}

async function createQueuedSource() {
  return await db.iiifSourcesAsync.create({
    collection_id: 1,
    source_type: 'ubc_oc',
    search_base_url: 'https://oc-index.test',
    collection_identifier: 'royalfisk',
    image_size: '2000,'
  });
}

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
  await db.runAsync(`INSERT INTO collections (id, name) VALUES (1, 'Test Coll')`);
  ({ runIiifSyncCycle } = require('../../utils/worker-iiif'));
}, 60_000);

describe('runIiifSyncCycle', () => {
  it('imports one pure-reference document per manifest, with derived image URLs', async () => {
    const sourceId = await createQueuedSource();
    await runIiifSyncCycle({
      adapters: { ubc_oc: makeFakeAdapter() },
      fetchJson: fakeFetchJson
    });

    const source = await db.iiifSourcesAsync.getById(sourceId);
    expect(source.status).toBe('done');
    expect(source.manifests_imported).toBe(2);

    const docs = await db.allAsync(`SELECT * FROM documents ORDER BY id ASC`);
    expect(docs.length).toBe(2);

    const docA = docs[0];
    // image_path is a remote IIIF derivative — NEVER a /uploads path (pure reference).
    expect(docA.image_path).toBe('https://iiif.test/image/cdm.royalfisk.1-0001.0000/full/2000,/0/default.jpg');
    const metaA = JSON.parse(docA.metadata);
    expect(metaA.document_type).toBe('letter');
    expect(metaA.iiif_source_id).toBe(sourceId);
    expect(metaA.iiif_canvas_count).toBe(2);
    // second canvas → additional_pages
    expect(metaA.additional_pages).toEqual(['https://iiif.test/image/cdm.royalfisk.1-0001.0001/full/2000,/0/default.jpg']);

    const metaB = JSON.parse(docs[1].metadata);
    expect(metaB.iiif_canvas_count).toBe(1);
    expect(metaB.additional_pages).toBeUndefined(); // single-page → no additional_pages key
  });

  it('links each document to the source collection', async () => {
    const rows = await db.allAsync(`SELECT DISTINCT collection_id FROM document_collections`);
    expect(rows.map((r) => r.collection_id)).toEqual([1]);
  });

  it('writes UBC FullText as an is_best transcript only when present', async () => {
    const docs = await db.allAsync(`SELECT * FROM documents ORDER BY id ASC`);
    const tA = await db.allAsync(`SELECT * FROM transcripts WHERE document_id = ?`, [docs[0].id]);
    expect(tA.length).toBe(1);
    expect(tA[0].is_best).toBe(1);
    expect(tA[0].content).toMatch(/Dear friend/);

    const tB = await db.allAsync(`SELECT * FROM transcripts WHERE document_id = ?`, [docs[1].id]);
    expect(tB.length).toBe(0); // no FullText → no transcript
  });

  it('never enqueues an LLM transcription job (that is the separate button)', async () => {
    const jobs = await db.allAsync(`SELECT COUNT(*) AS n FROM transcription_jobs`);
    expect(jobs[0].n).toBe(0);
  });

  it('re-sync is idempotent: the ledger prevents duplicate documents', async () => {
    const sourceId = await db.iiifSourcesAsync.resync(
      (await db.allAsync(`SELECT id FROM iiif_sources ORDER BY id ASC LIMIT 1`))[0].id
    ) && (await db.allAsync(`SELECT id FROM iiif_sources ORDER BY id ASC LIMIT 1`))[0].id;

    await runIiifSyncCycle({
      adapters: { ubc_oc: makeFakeAdapter() },
      fetchJson: fakeFetchJson
    });

    const docs = await db.allAsync(`SELECT COUNT(*) AS n FROM documents`);
    expect(docs[0].n).toBe(2); // still 2 — no duplicates
    const src = await db.iiifSourcesAsync.getById(sourceId);
    expect(src.status).toBe('done');
  });

  it('requeues (not fails) the source on a transient fetch error', async () => {
    await db.runAsync('DELETE FROM iiif_sources'); // isolate: only one queued source
    const sourceId = await db.iiifSourcesAsync.create({
      collection_id: 1, source_type: 'ubc_oc', collection_identifier: 'royalfisk'
    });
    await runIiifSyncCycle({
      adapters: { ubc_oc: makeFakeAdapter() },
      fetchJson: async () => { throw new Error('IIIF_JSON_FETCH_FAILED: 503 upstream'); }
    });
    const src = await db.iiifSourcesAsync.getById(sourceId);
    expect(src.status).toBe('queued'); // resumable, not failed
    expect(src.error).toMatch(/503/);
  });

  it('fails the source on a permanent error (unknown source_type)', async () => {
    await db.runAsync('DELETE FROM iiif_sources'); // isolate: only one queued source
    const sourceId = await db.iiifSourcesAsync.create({
      collection_id: 1, source_type: 'not_a_real_adapter', collection_identifier: 'x'
    });
    await runIiifSyncCycle({ adapters: {}, fetchJson: fakeFetchJson });
    const src = await db.iiifSourcesAsync.getById(sourceId);
    expect(src.status).toBe('failed');
    expect(src.error).toMatch(/Unknown IIIF source_type/);
  });
});
