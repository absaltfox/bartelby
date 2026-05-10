'use strict';

const express = require('express');
const router = express.Router();
const { collectionsAsync, usersAsync, userCollectionAccessAsync } = require('../database/db');
const { requireAdmin } = require('../middleware/auth');
const { normalizeCollectionAssets, normalizeDocumentAssets, normalizeCollectionAssetsForDelivery, normalizeDocumentAssetsForDelivery } = require('../utils/document-assets');
const audit = require('../utils/audit-log');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

// List collections
router.get('/', asyncHandler(async (req, res) => {
  const adminList = await collectionsAsync.getAdminListView();
  const allCollections = await Promise.all(adminList.map(async (c) => ({
    ...(await normalizeCollectionAssetsForDelivery(c)),
    documents: await Promise.all((c.documents || []).map(normalizeDocumentAssetsForDelivery))
  })));

  const activeUsers = (await usersAsync.getAll()).filter((u) =>
    u.status === 'active' && u.role !== 'admin' && !u.access_all
  );

  res.render('admin/collections', {
    pageTitle: 'Collections',
    allCollections,
    activeUsers,
    saved: req.query.saved === '1',
    error: req.query.error || null,
    queuedCollectionName: req.query.queuedCollectionName || null,
    queuedCount: parseInt(req.query.queuedCount, 10) || 0,
    queuedMode: req.query.queuedMode || null,
    skippedPending: parseInt(req.query.skippedPending, 10) || 0,
    skippedNoTranscript: parseInt(req.query.skippedNoTranscript, 10) || 0
  });
}));

// Create
router.post('/', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const visibility = req.body.visibility || 'private';
  const is_public = visibility === 'authenticated' || visibility === 'public';
  const is_world_public = visibility === 'public';
  const allow_export = req.body.allow_export === '1';
  const auto_group_pages = req.body.auto_group_pages === '1';

  if (!name) return res.redirect('/admin/collections?error=Name+is+required');

  try {
    await collectionsAsync.create({ name, description, is_public, is_world_public, allow_export, auto_group_pages, createdBy: req.user.id });
    res.redirect('/admin/collections?saved=1');
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      res.redirect('/admin/collections?error=A+collection+with+that+name+already+exists');
    } else {
      res.redirect('/admin/collections?error=' + encodeURIComponent(err.message));
    }
  }
}));

// Update
router.post('/:id/edit', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const visibility = req.body.visibility || 'private';
  const is_public = visibility === 'authenticated' || visibility === 'public';
  const is_world_public = visibility === 'public';
  const allow_export = req.body.allow_export === '1' ? 1 : 0;
  const auto_group_pages = req.body.auto_group_pages === '1' ? 1 : 0;
  const sentiment_enabled = req.body.sentiment_enabled === '1' ? 1 : 0;

  if (!name) return res.redirect('/admin/collections?error=Name+is+required');

  try {
    await collectionsAsync.update(id, { name, description, is_public, is_world_public });
    await collectionsAsync.setAllowExport(id, allow_export);
    await collectionsAsync.setAutoGroupPages(id, auto_group_pages);
    await collectionsAsync.setSentimentEnabled(id, sentiment_enabled);
    res.redirect('/admin/collections?saved=1');
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message));
  }
}));

// Grant access to a user (with role)
router.post('/:id/access/grant', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id);
  const userId = parseInt(req.body.user_id);
  const role = req.body.role || 'viewer';
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.grant(userId, collectionId, role);
    audit.log('admin.collection_access_granted', {
      ...audit.reqContext(req),
      collectionId,
      targetUserId: userId,
      role
    });
  }
  res.redirect('/admin/collections?saved=1#collection-' + collectionId);
}));

// Revoke access from a user
router.post('/:id/access/revoke/:userId', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id);
  const userId = parseInt(req.params.userId);
  if (!isNaN(userId) && !isNaN(collectionId)) {
    await userCollectionAccessAsync.revoke(userId, collectionId);
  }
  res.redirect('/admin/collections#collection-' + collectionId);
}));

// Set preview image
router.post('/:id/preview', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  const documentId = req.body.preview_document_id ? parseInt(req.body.preview_document_id, 10) : null;
  try {
    await collectionsAsync.setPreviewDocument(collectionId, documentId);
    audit.log('admin.collection_preview_updated', {
      ...audit.reqContext(req),
      collectionId,
      previewDocumentId: documentId
    });
    res.redirect('/admin/collections?saved=1#collection-' + collectionId);
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message) + '#collection-' + collectionId);
  }
}));

// Delete
router.post('/:id/delete', asyncHandler(async (req, res) => {
  const collectionId = parseInt(req.params.id);
  await collectionsAsync.delete(collectionId);
  audit.log('admin.collection_deleted', {
    ...audit.reqContext(req),
    collectionId
  });
  res.redirect('/admin/collections');
}));

module.exports = router;
