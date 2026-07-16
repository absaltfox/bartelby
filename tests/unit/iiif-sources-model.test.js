'use strict';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

// Covers the Phase 1c iiifSourcesAsync model (feat/iiif-ingestion). Mirrors the
// job-model claim/heartbeat/progress/log shape of importJobsAsync per
// docs/background-jobs.md, plus the iiif_imported_manifests idempotency ledger
// that makes a re-sync create zero duplicate documents.

let db;

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
  await db.runAsync(`INSERT INTO collections (id, name) VALUES (1, 'Test Coll')`);
}, 60_000);

describe('iiifSourcesAsync model', () => {
  let sourceId;

  it('creates a queued source and lists it per collection', async () => {
    sourceId = await db.iiifSourcesAsync.create({
      collection_id: 1,
      source_type: 'ubc_oc',
      search_base_url: 'https://oc-index.library.ubc.ca',
      collection_identifier: 'royalfisk',
      query_json: { size: 10 },
      api_key: 'secret-key',
      label: 'Royal Fisk correspondence',
      image_size: '2000,',
      created_by: 7
    });
    expect(sourceId).toBeGreaterThan(0);

    const row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.status).toBe('queued');
    expect(row.collection_id).toBe(1);
    expect(row.source_type).toBe('ubc_oc');
    // query_json is JSON-stringified on create when passed an object.
    expect(row.query_json).toBe('{"size":10}');
    expect(row.created_by).toBe(7);

    const list = await db.iiifSourcesAsync.getByCollectionId(1);
    expect(list.map((s) => s.id)).toContain(sourceId);
    expect(await db.iiifSourcesAsync.getByCollectionId(999)).toEqual([]);
  });

  it('claimNextQueued flips to running exactly once', async () => {
    const claimed = await db.iiifSourcesAsync.claimNextQueued();
    expect(claimed.id).toBe(sourceId);
    expect(claimed.status).toBe('running');
    expect(claimed.started_at).toBeTruthy();
    expect(claimed.last_heartbeat_at).toBeTruthy();
    expect(await db.iiifSourcesAsync.claimNextQueued()).toBeNull();
  });

  it('updateProgress persists counters and only writes cursor when provided', async () => {
    await db.iiifSourcesAsync.updateProgress(sourceId, { manifests_total: 3, manifests_imported: 1 });
    let row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.manifests_total).toBe(3);
    expect(row.manifests_imported).toBe(1);
    expect(row.cursor).toBeNull();

    await db.iiifSourcesAsync.updateProgress(sourceId, { manifests_imported: 2, cursor: 'offset:20' });
    row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.manifests_imported).toBe(2);
    expect(row.manifests_total).toBe(3); // unchanged (COALESCE)
    expect(row.cursor).toBe('offset:20');

    // Omitting cursor leaves the existing value untouched.
    await db.iiifSourcesAsync.updateProgress(sourceId, { manifests_imported: 3 });
    row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.cursor).toBe('offset:20');
  });

  it('appendLog is surfaced through getById', async () => {
    await db.iiifSourcesAsync.appendLog(sourceId, 'Fetched manifest cdm.royalfisk.1-0040134.0000');
    const row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.log).toMatch(/1-0040134/);
  });

  it('ledger gates duplicates: manifestImported / recordImportedManifest', async () => {
    const manifestId = 'https://iiif.library.ubc.ca/presentation/cdm.royalfisk.1-0040134.0000/manifest';
    expect(await db.iiifSourcesAsync.manifestImported(sourceId, manifestId)).toBe(false);
    await db.iiifSourcesAsync.recordImportedManifest(sourceId, manifestId, 101);
    expect(await db.iiifSourcesAsync.manifestImported(sourceId, manifestId)).toBe(true);
    // Re-recording is a no-op (INSERT OR IGNORE on the UNIQUE ledger key).
    await db.iiifSourcesAsync.recordImportedManifest(sourceId, manifestId, 999);
    const rows = await db.allAsync(
      'SELECT document_id FROM iiif_imported_manifests WHERE source_id = ? AND manifest_id = ?',
      [sourceId, manifestId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].document_id).toBe(101); // first write wins
  });

  it('markDone stamps last_synced_at and clears error', async () => {
    await db.iiifSourcesAsync.markDone(sourceId);
    const row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.status).toBe('done');
    expect(row.completed_at).toBeTruthy();
    expect(row.last_synced_at).toBeTruthy();
    expect(row.error).toBeNull();
  });

  it('resync requeues a done/failed source, resets cursor, preserves ledger', async () => {
    const changes = await db.iiifSourcesAsync.resync(sourceId);
    expect(changes).toBe(1);
    const row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.status).toBe('queued');
    expect(row.cursor).toBeNull();
    expect(row.completed_at).toBeNull();
    // Ledger untouched, so the re-crawl still de-dupes.
    const manifestId = 'https://iiif.library.ubc.ca/presentation/cdm.royalfisk.1-0040134.0000/manifest';
    expect(await db.iiifSourcesAsync.manifestImported(sourceId, manifestId)).toBe(true);
  });

  it('requeueForRetry returns a running source to the queue with the error recorded', async () => {
    await db.iiifSourcesAsync.claimNextQueued(); // back to running
    await db.iiifSourcesAsync.requeueForRetry(sourceId, 'UBC search 503');
    const row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.status).toBe('queued');
    expect(row.error).toBe('UBC search 503');
    expect(row.machine_id).toBeNull();
  });

  it('markFailed records the error and getCounts reflects it', async () => {
    await db.iiifSourcesAsync.claimNextQueued();
    await db.iiifSourcesAsync.markFailed(sourceId, 'fatal: manifest 404');
    const row = await db.iiifSourcesAsync.getById(sourceId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/404/);

    const counts = await db.iiifSourcesAsync.getCounts();
    expect(counts.total).toBeGreaterThanOrEqual(1);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
  });
});
