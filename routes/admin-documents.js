const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('../middleware/auth');
const { documents, collections, documentCollections, saveDatabase } = require('../database/db');

router.use(requireAdmin);

// List all documents
router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const collectionFilter = req.query.collection ? parseInt(req.query.collection) : null;
  const allowedPerPage = [25, 50, 75, 100];
  const perPage = allowedPerPage.includes(parseInt(req.query.perPage)) ? parseInt(req.query.perPage) : 25;
  const limit = perPage;
  const offset = (page - 1) * limit;

  let allDocs, totalCount;

  if (collectionFilter) {
    // Filter by collection
    const docIds = documentCollections.getByCollectionId(collectionFilter).map(d => d.document_id);
    totalCount = docIds.length;
    allDocs = docIds.length > 0
      ? documents.getByIds(docIds, limit, offset)
      : [];
  } else {
    totalCount = documents.getCount();
    allDocs = documents.getAll(limit, offset);
  }

  const totalPages = Math.ceil(totalCount / limit);

  const docsWithCollections = allDocs.map(doc => ({
    ...doc,
    collections: documentCollections.getByDocumentId(doc.id)
  }));

  res.render('admin/documents', {
    pageTitle: 'Documents',
    docs: docsWithCollections,
    allCollections: collections.getAll(),
    currentPage: page,
    totalPages,
    totalCount,
    perPage,
    collectionFilter,
    deleted: req.query.deleted === '1',
    queryError: req.query.error || null
  });
});

// ── Bulk routes (MUST be before /:id routes) ────────────────────────────────

// Bulk delete documents (JSON API)
router.post('/bulk/delete', express.json(), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'No document IDs provided' });

  let deleted = 0;
  for (const id of ids) {
    const doc = documents.getById(id);
    if (!doc) continue;

    if (doc.image_path) {
      const imagePath = path.join(__dirname, '..', 'public', doc.image_path);
      try { if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); } catch (e) {}
    }
    let metadata = doc.metadata;
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch (e) { metadata = {}; }
    }
    if (metadata && Array.isArray(metadata.additional_pages)) {
      for (const pagePath of metadata.additional_pages) {
        const fullPath = path.join(__dirname, '..', 'public', pagePath);
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
      }
    }

    documents.delete(id);
    deleted++;
  }
  saveDatabase();
  res.json({ success: true, deleted });
});

// Bulk update collections (JSON API)
router.post('/bulk/collections', express.json(), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  const collectionIds = Array.isArray(req.body.collectionIds)
    ? req.body.collectionIds.map(Number).filter(n => !isNaN(n))
    : [];
  const mode = req.body.mode || 'set';

  if (ids.length === 0) return res.status(400).json({ error: 'No document IDs provided' });

  for (const docId of ids) {
    const doc = documents.getById(docId);
    if (!doc) continue;

    if (mode === 'add') {
      const existing = documentCollections.getByDocumentId(docId).map(c => c.id);
      const merged = [...new Set([...existing, ...collectionIds])];
      documentCollections.setForDocument(docId, merged);
    } else {
      documentCollections.setForDocument(docId, collectionIds);
    }
  }
  saveDatabase();
  res.json({ success: true, updated: ids.length });
});

// ── Per-document routes ─────────────────────────────────────────────────────

// Update document collections (JSON API)
router.post('/:id/collections', express.json(), (req, res) => {
  const docId = parseInt(req.params.id);
  const doc = documents.getById(docId);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  const collectionIds = Array.isArray(req.body.collectionIds)
    ? req.body.collectionIds.map(Number).filter(n => !isNaN(n))
    : [];

  documentCollections.setForDocument(docId, collectionIds);
  saveDatabase();

  const updated = documentCollections.getByDocumentId(docId);
  res.json({ success: true, collections: updated });
});

// Delete document
router.post('/:id/delete', (req, res) => {
  const doc = documents.getById(parseInt(req.params.id));
  if (!doc) return res.redirect('/admin/documents?error=not_found');

  if (doc.image_path) {
    const imagePath = path.join(__dirname, '..', 'public', doc.image_path);
    try { if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); } catch (e) {}
  }
  let metadata = doc.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch (e) { metadata = {}; }
  }
  if (metadata && Array.isArray(metadata.additional_pages)) {
    for (const pagePath of metadata.additional_pages) {
      const fullPath = path.join(__dirname, '..', 'public', pagePath);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
    }
  }

  documents.delete(doc.id);
  saveDatabase();
  res.redirect('/admin/documents?deleted=1');
});

module.exports = router;
