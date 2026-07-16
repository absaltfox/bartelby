'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// feat/iiif-ingestion Phase 1d — an iiif_source left 'running' by an unclean
// shutdown must be REQUEUED (not failed) on the next startup, because the
// iiif_imported_manifests ledger makes the re-crawl idempotent. Mirrors the
// existing sentiment-stale-recovery test harness.
describe('IIIF sync stale-source recovery', () => {
  let db;
  let tmpDir;

  async function reset() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iiif-stale-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    await db.runAsync(`INSERT INTO collections (id, name) VALUES (1, 'Coll')`);
  }

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('running + machine_id NULL → requeued after recovery', async () => {
    await reset();
    await db.runAsync(
      `INSERT INTO iiif_sources (id, collection_id, source_type, status, started_at, last_heartbeat_at)
       VALUES (1, 1, 'ubc_oc', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    await db.initializeSchema({ runStaleJobRecovery: true });
    const row = await db.getAsync(`SELECT status, started_at, completed_at FROM iiif_sources WHERE id = 1`);
    expect(row.status).toBe('queued');
    expect(row.started_at).toBeNull();
    expect(row.completed_at).toBeNull();
  });

  test('running + machine_id set is left for the heartbeat sweeper (not requeued at startup)', async () => {
    await reset();
    await db.runAsync(
      `INSERT INTO iiif_sources (id, collection_id, source_type, status, machine_id)
       VALUES (2, 1, 'ubc_oc', 'running', 'fly-machine-abc')`
    );
    await db.initializeSchema({ runStaleJobRecovery: true });
    const row = await db.getAsync(`SELECT status FROM iiif_sources WHERE id = 2`);
    expect(row.status).toBe('running');
  });

  test('done sources are untouched by recovery', async () => {
    await reset();
    await db.runAsync(
      `INSERT INTO iiif_sources (id, collection_id, source_type, status)
       VALUES (3, 1, 'ubc_oc', 'done')`
    );
    await db.initializeSchema({ runStaleJobRecovery: true });
    const row = await db.getAsync(`SELECT status FROM iiif_sources WHERE id = 3`);
    expect(row.status).toBe('done');
  });
});
