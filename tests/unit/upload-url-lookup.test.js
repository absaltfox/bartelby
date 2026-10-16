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
// probes the image_path index (v87) first and then document_page_urls (v93),
// which triggers keep in step with metadata.additional_pages. Neither probe
// scans documents. Issue #75.
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
  it('the primary probe is index-served, not a table scan (v87)', async () => {
    const plan = await planFor('SELECT id FROM documents WHERE image_path = ?', ['/uploads/plan-probe.jpg']);
    expect(plan).toContain('idx_documents_image_path');
    expect(plan).not.toContain('SCAN documents');
  });

  it('the additional-page probe is index-served, not a table scan (v93)', async () => {
    const plan = await planFor('SELECT document_id AS id FROM document_page_urls WHERE url = ?', ['/uploads/plan-probe.jpg']);
    expect(plan).toMatch(/USING (COVERING )?INDEX/);
    expect(plan).not.toMatch(/SCAN (documents|document_page_urls)/);
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

  it('resolves an additional page through document_page_urls', async () => {
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

  describe('document_page_urls stays in step with metadata', () => {
    async function pageUrlsFor(documentId) {
      const rows = await db.allAsync(
        'SELECT url FROM document_page_urls WHERE document_id = ? ORDER BY url',
        [documentId]
      );
      return rows.map((row) => row.url);
    }

    it('replaces the rows when metadata changes, and drops them on delete', async () => {
      const documentId = await db.documentsAsync.create({
        title: 'Page URL Sync',
        date_created: null,
        description: null,
        image_path: '/uploads/sync-p1.jpg',
        metadata: { additional_pages: ['/uploads/sync-p2.jpg', '/uploads/sync-p3.jpg'] }
      });
      expect(await pageUrlsFor(documentId)).toEqual(['/uploads/sync-p2.jpg', '/uploads/sync-p3.jpg']);

      await db.documentsAsync.update(documentId, {
        metadata: { additional_pages: ['/uploads/sync-p3.jpg', '/uploads/sync-p4.jpg'] }
      });
      expect(await pageUrlsFor(documentId)).toEqual(['/uploads/sync-p3.jpg', '/uploads/sync-p4.jpg']);
      expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/sync-p2.jpg')).toEqual([]);
      expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/sync-p4.jpg')).toEqual([documentId]);

      await db.documentsAsync.update(documentId, { title: 'Page URL Sync (renamed)' });
      expect(await pageUrlsFor(documentId)).toEqual(['/uploads/sync-p3.jpg', '/uploads/sync-p4.jpg']);

      await db.documentsAsync.delete(documentId);
      expect(await pageUrlsFor(documentId)).toEqual([]);
      expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/sync-p3.jpg')).toEqual([]);
    });

    it('does not fail a write whose metadata is NULL or has no page list', async () => {
      // Invalid JSON never gets this far: the json_extract() expression indexes
      // on documents (database/db.js, document_type and location) reject it.
      await db.runAsync(
        "INSERT INTO documents (title, image_path, metadata) VALUES ('Null Metadata', '/uploads/null-meta.jpg', NULL)"
      );
      const nullMeta = await db.getAsync("SELECT id FROM documents WHERE title = 'Null Metadata'");
      expect(await pageUrlsFor(nullMeta.id)).toEqual([]);
      await db.runAsync('UPDATE documents SET metadata = NULL WHERE id = ?', [nullMeta.id]);
      expect(await pageUrlsFor(nullMeta.id)).toEqual([]);

      const noPages = await db.documentsAsync.create({
        title: 'No Page List',
        date_created: null,
        description: null,
        image_path: '/uploads/no-pages.jpg',
        metadata: { additional_pages: 'not-an-array', author: 'someone' }
      });
      // A bare string is what json_each yields for a scalar; the old scan matched
      // it the same way, so this keeps lookup behaviour unchanged.
      expect(await pageUrlsFor(noPages)).toEqual(['not-an-array']);
    });

    it('fills an empty table from existing documents, once', async () => {
      const documentId = await db.documentsAsync.create({
        title: 'Page URL Backfill',
        date_created: null,
        description: null,
        image_path: '/uploads/fill-p1.jpg',
        metadata: { additional_pages: ['/uploads/fill-p2.jpg'] }
      });

      // Simulate a database migrated before the triggers existed.
      for (const name of ['document_page_urls_insert', 'document_page_urls_update', 'document_page_urls_delete']) {
        await db.runAsync(`DROP TRIGGER IF EXISTS ${name}`);
      }
      await db.runAsync('DELETE FROM document_page_urls');

      await db.ensureDocumentPageUrls();
      expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/fill-p2.jpg')).toEqual([documentId]);

      const triggers = await db.allAsync(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'document_page_urls_%' ORDER BY name"
      );
      expect(triggers.map((row) => row.name)).toEqual([
        'document_page_urls_delete',
        'document_page_urls_insert',
        'document_page_urls_update'
      ]);

      // A second run with rows present does not refill: a row removed by hand
      // stays removed, which shows the fill was skipped.
      await db.runAsync('DELETE FROM document_page_urls WHERE url = ?', ['/uploads/fill-p2.jpg']);
      await db.ensureDocumentPageUrls();
      expect(await db.documentsAsync.getIdsByUploadUrl('/uploads/fill-p2.jpg')).toEqual([]);
    });
  });
});
