'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

// The /uploads authorizing proxy resolves an upload URL to its document(s)
// *before* running any access check, and `anonymousUploadLimiter` skips
// authenticated requests — so this lookup sitting on a full-table scan is an
// availability problem, not just a latency one. `documentsAsync.getIdsByUploadUrl`
// probes the v51 index first and falls back to the un-indexable
// json_each(additional_pages) scan only on a miss.
//
// Per docs/reviews/2026-07-27-front-end-performance-review.md (findings P12,
// P16) and docs/db-migrations.md.
let db;

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
}, 60_000);

async function planFor(sql, params = []) {
  const rows = await db.allAsync(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((r) => r.detail).join('\n');
}

describe('upload URL to document lookup', () => {
  it('the primary probe is index-served, not a table scan (v51)', async () => {
    const plan = await planFor('SELECT id FROM documents WHERE image_path = ?', ['/uploads/plan-probe.jpg']);
    expect(plan).toContain('idx_documents_image_path');
    expect(plan).not.toContain('SCAN documents');
  });

  it('the combined OR form the split replaced still cannot use the index', async () => {
    // Recorded so the two statements are not "simplified" back into one: the
    // json_each disjunct is not index-satisfiable, and SQLite's OR-to-index
    // union requires every term to be.
    const plan = await planFor(`
      SELECT DISTINCT d.id
      FROM documents d
      WHERE d.image_path = ?
         OR EXISTS (
           SELECT 1 FROM json_each(COALESCE(d.metadata, '{}'), '$.additional_pages')
           WHERE value = ?
         )
    `, ['/uploads/plan-probe.jpg', '/uploads/plan-probe.jpg']);
    expect(plan).toContain('SCAN d');
  });

  it('resolves a page master through the indexed probe', async () => {
    const documentId = await db.documentsAsync.create({
      title: 'Upload Lookup Master',
      date_created: null,
      description: null,
      image_path: '/uploads/lookup-master.jpg',
      metadata: {}
    });

    const ids = await db.documentsAsync.getIdsByUploadUrl('/uploads/lookup-master.jpg');
    expect(ids).toEqual([documentId]);
  });

  it('still resolves an additional page through the fallback scan', async () => {
    const documentId = await db.documentsAsync.create({
      title: 'Upload Lookup Multi Page',
      date_created: null,
      description: null,
      image_path: '/uploads/lookup-multi-p1.jpg',
      metadata: { additional_pages: ['/uploads/lookup-multi-p2.jpg', '/uploads/lookup-multi-p3.jpg'] }
    });

    expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/lookup-multi-p1.jpg')).toEqual([documentId]);
    expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/lookup-multi-p2.jpg')).toEqual([documentId]);
    expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/lookup-multi-p3.jpg')).toEqual([documentId]);
  });

  it('returns every document sharing a master, and nothing for an unknown URL', async () => {
    const first = await db.documentsAsync.create({
      title: 'Upload Lookup Shared A',
      date_created: null,
      description: null,
      image_path: '/uploads/lookup-shared.jpg',
      metadata: {}
    });
    const second = await db.documentsAsync.create({
      title: 'Upload Lookup Shared B',
      date_created: null,
      description: null,
      image_path: '/uploads/lookup-shared.jpg',
      metadata: {}
    });

    const ids = await db.documentsAsync.getIdsByUploadUrl('/uploads/lookup-shared.jpg');
    expect(ids.sort((a, b) => a - b)).toEqual([first, second].sort((a, b) => a - b));

    expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/nope.jpg')).toEqual([]);
    expect(await db.documentsAsync.getIdsByUploadUrl('')).toEqual([]);
  });
});
