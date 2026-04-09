const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const storage = require('../utils/storage');
const { normalizeDocumentAssets, parseMetadata } = require('../utils/document-assets');
const { documentsAsync, collectionsAsync, documentCollectionsAsync } = require('../database/db');

router.use(requireAdmin);

// List all documents
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const collectionFilter = req.query.collection ? parseInt(req.query.collection) : null;
  const allowedPerPage = [25, 50, 75, 100];
  const perPage = allowedPerPage.includes(parseInt(req.query.perPage)) ? parseInt(req.query.perPage) : 25;
  const limit = perPage;
  const offset = (page - 1) * limit;

  let allDocs, totalCount;

  if (collectionFilter) {
    // Filter by collection
    const docIds = (await documentCollectionsAsync.getByCollectionId(collectionFilter)).map(d => d.document_id);
    totalCount = docIds.length;
    allDocs = docIds.length > 0
      ? await documentsAsync.getByIds(docIds, limit, offset)
      : [];
  } else {
    totalCount = await documentsAsync.getCount({ isAdmin: true });
    allDocs = await documentsAsync.getAll(limit, offset, { isAdmin: true });
  }

  const totalPages = Math.ceil(totalCount / limit);

  const docsWithCollections = allDocs.map(doc => ({
    ...normalizeDocumentAssets(doc),
    collections: []
  }));

  for (const doc of docsWithCollections) {
    doc.collections = await documentCollectionsAsync.getByDocumentId(doc.id);
  }

  res.render('admin/documents', {
    pageTitle: 'Documents',
    docs: docsWithCollections,
    allCollections: await collectionsAsync.getAll(),
    currentPage: page,
    totalPages,
    totalCount,
    perPage,
    collectionFilter,
    deleted: req.query.deleted === '1',
    queryError: req.query.error || null,
    queuedDocumentTitle: req.query.queuedDocumentTitle || null
  });
});

// ── Bulk routes (MUST be before /:id routes) ────────────────────────────────

// Bulk delete documents (JSON API)
router.post('/bulk/delete', express.json(), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'No document IDs provided' });

  let deleted = 0;
  for (const id of ids) {
    const doc = await documentsAsync.getById(id);
    if (!doc) continue;

    if (doc.image_path) {
      try { await storage.deleteUploadByUrl(doc.image_path); } catch (e) {}
    }
    const metadata = parseMetadata(doc.metadata);
    if (metadata && Array.isArray(metadata.additional_pages)) {
      for (const pagePath of metadata.additional_pages) {
        try { await storage.deleteUploadByUrl(pagePath); } catch (e) {}
      }
    }

    await documentsAsync.delete(id);
    deleted++;
  }
  res.json({ success: true, deleted });
});

// Bulk update collections (JSON API)
router.post('/bulk/collections', express.json(), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  const collectionIds = Array.isArray(req.body.collectionIds)
    ? req.body.collectionIds.map(Number).filter(n => !isNaN(n))
    : [];
  const mode = req.body.mode || 'set';

  if (ids.length === 0) return res.status(400).json({ error: 'No document IDs provided' });

  for (const docId of ids) {
    const doc = await documentsAsync.getById(docId);
    if (!doc) continue;

    if (mode === 'add') {
      const existing = (await documentCollectionsAsync.getByDocumentId(docId)).map(c => c.id);
      const merged = [...new Set([...existing, ...collectionIds])];
      await documentCollectionsAsync.setForDocument(docId, merged);
    } else {
      await documentCollectionsAsync.setForDocument(docId, collectionIds);
    }
  }
  res.json({ success: true, updated: ids.length });
});

// ── Per-document routes ─────────────────────────────────────────────────────

// Update document collections (JSON API)
router.post('/:id/collections', express.json(), async (req, res) => {
  const docId = parseInt(req.params.id);
  const doc = await documentsAsync.getById(docId);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  const collectionIds = Array.isArray(req.body.collectionIds)
    ? req.body.collectionIds.map(Number).filter(n => !isNaN(n))
    : [];

  await documentCollectionsAsync.setForDocument(docId, collectionIds);

  const updated = await documentCollectionsAsync.getByDocumentId(docId);
  res.json({ success: true, collections: updated });
});

// Delete document
router.post('/:id/delete', async (req, res) => {
  const doc = await documentsAsync.getById(parseInt(req.params.id));
  if (!doc) return res.redirect('/admin/documents?error=not_found');

  if (doc.image_path) {
    try { await storage.deleteUploadByUrl(doc.image_path); } catch (e) {}
  }
  const metadata = parseMetadata(doc.metadata);
  if (metadata && Array.isArray(metadata.additional_pages)) {
    for (const pagePath of metadata.additional_pages) {
      try { await storage.deleteUploadByUrl(pagePath); } catch (e) {}
    }
  }

  await documentsAsync.delete(doc.id);
  res.redirect('/admin/documents?deleted=1');
});

module.exports = router;
