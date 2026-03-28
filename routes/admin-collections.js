'use strict';

const express = require('express');
const router = express.Router();
const { collectionsAsync, usersAsync, userCollectionAccessAsync, documentCollectionsAsync, documentsAsync } = require('../database/db');
const { requireAdmin } = require('../middleware/auth');
const { normalizeCollectionAssets, normalizeDocumentAssets } = require('../utils/document-assets');

router.use(requireAdmin);

// List collections
router.get('/', async (req, res) => {
  const allCollections = (await collectionsAsync.getAllWithThumbnails()).map(normalizeCollectionAssets);

  // Attach per-collection user access list + documents for preview picker
  const collectionsWithAccess = [];
  for (const c of allCollections) {
    const docIds = (await documentCollectionsAsync.getByCollectionId(c.id)).map(dc => dc.document_id);
    const collectionDocs = docIds.length > 0
      ? (await documentsAsync.getByIds(docIds, 100, 0)).map(normalizeDocumentAssets)
      : [];
    collectionsWithAccess.push({
      ...c,
      grantedUsers: await userCollectionAccessAsync.getByCollectionId(c.id),
      documents: collectionDocs
    });
  }

  // Non-admin, non-access_all active users (candidates for access grants)
  const activeUsers = (await usersAsync.getAll()).filter(u =>
    u.status === 'active' && u.role !== 'admin' && !u.access_all
  );

  res.render('admin/collections', {
    pageTitle: 'Collections',
    allCollections: collectionsWithAccess,
    activeUsers,
    saved: req.query.saved === '1',
    error: req.query.error || null
  });
});

// Create
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const is_public = req.body.is_public === '1';
  const allow_export = req.body.allow_export === '1';

  if (!name) return res.redirect('/admin/collections?error=Name+is+required');

  try {
    await collectionsAsync.create({ name, description, is_public, allow_export, createdBy: req.user.id });
    res.redirect('/admin/collections?saved=1');
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      res.redirect('/admin/collections?error=A+collection+with+that+name+already+exists');
    } else {
      res.redirect('/admin/collections?error=' + encodeURIComponent(err.message));
    }
  }
});

// Update
router.post('/:id/edit', express.urlencoded({ extended: false }), async (req, res) => {
  const id = parseInt(req.params.id);
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const is_public = req.body.is_public === '1';
  const allow_export = req.body.allow_export === '1' ? 1 : 0;

  if (!name) return res.redirect('/admin/collections?error=Name+is+required');

  try {
    await collectionsAsync.update(id, { name, description, is_public });
    await collectionsAsync.setAllowExport(id, allow_export);
    res.redirect('/admin/collections?saved=1');
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message));
  }
});

// Grant access to a user (with role)
router.post('/:id/access/grant', express.urlencoded({ extended: false }), async (req, res) => {
  const collectionId = parseInt(req.params.id);
  const userId = parseInt(req.body.user_id);
  const role = req.body.role || 'viewer';
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.grant(userId, collectionId, role);
  }
  res.redirect('/admin/collections?saved=1#collection-' + collectionId);
});

// Revoke access from a user
router.post('/:id/access/revoke/:userId', async (req, res) => {
  const collectionId = parseInt(req.params.id);
  const userId = parseInt(req.params.userId);
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.revoke(userId, collectionId);
  }
  res.redirect('/admin/collections#collection-' + collectionId);
});

// Set preview image
router.post('/:id/preview', express.urlencoded({ extended: false }), async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  const documentId = req.body.preview_document_id ? parseInt(req.body.preview_document_id, 10) : null;
  try {
    await collectionsAsync.setPreviewDocument(collectionId, documentId);
    res.redirect('/admin/collections?saved=1#collection-' + collectionId);
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message) + '#collection-' + collectionId);
  }
});

// Delete
router.post('/:id/delete', async (req, res) => {
  await collectionsAsync.delete(parseInt(req.params.id));
  res.redirect('/admin/collections');
});

module.exports = router;
