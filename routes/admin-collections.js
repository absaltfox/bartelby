'use strict';

const express = require('express');
const router = express.Router();
const { collections, users, userCollectionAccess, documentCollections, documents, saveDatabase } = require('../database/db');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// List collections
router.get('/', (req, res) => {
  const allCollections = collections.getAllWithThumbnails();

  // Attach per-collection user access list + documents for preview picker
  const collectionsWithAccess = allCollections.map(c => {
    const docIds = documentCollections.getByCollectionId(c.id).map(dc => dc.document_id);
    const collectionDocs = docIds.length > 0 ? documents.getByIds(docIds, 100, 0) : [];
    return {
      ...c,
      grantedUsers: userCollectionAccess.getByCollectionId(c.id),
      documents: collectionDocs
    };
  });

  // Non-admin, non-access_all active users (candidates for access grants)
  const activeUsers = users.getAll().filter(u =>
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
router.post('/', express.urlencoded({ extended: false }), (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const is_public = req.body.is_public === '1';

  if (!name) return res.redirect('/admin/collections?error=Name+is+required');

  try {
    collections.create({ name, description, is_public, createdBy: req.user.id });
    saveDatabase();
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
router.post('/:id/edit', express.urlencoded({ extended: false }), (req, res) => {
  const id = parseInt(req.params.id);
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  const is_public = req.body.is_public === '1';

  if (!name) return res.redirect('/admin/collections?error=Name+is+required');

  try {
    collections.update(id, { name, description, is_public });
    saveDatabase();
    res.redirect('/admin/collections?saved=1');
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message));
  }
});

// Grant access to a user
router.post('/:id/access/grant', express.urlencoded({ extended: false }), (req, res) => {
  const collectionId = parseInt(req.params.id);
  const userId = parseInt(req.body.user_id);
  if (!isNaN(userId) && !isNaN(collectionId)) {
    userCollectionAccess.grant(userId, collectionId);
    saveDatabase();
  }
  res.redirect('/admin/collections?saved=1#collection-' + collectionId);
});

// Revoke access from a user
router.post('/:id/access/revoke/:userId', (req, res) => {
  const collectionId = parseInt(req.params.id);
  const userId = parseInt(req.params.userId);
  if (!isNaN(userId) && !isNaN(collectionId)) {
    userCollectionAccess.revoke(userId, collectionId);
    saveDatabase();
  }
  res.redirect('/admin/collections#collection-' + collectionId);
});

// Set preview image
router.post('/:id/preview', express.urlencoded({ extended: false }), (req, res) => {
  const collectionId = parseInt(req.params.id, 10);
  const documentId = req.body.preview_document_id ? parseInt(req.body.preview_document_id, 10) : null;
  try {
    collections.setPreviewDocument(collectionId, documentId);
    saveDatabase();
    res.redirect('/admin/collections?saved=1#collection-' + collectionId);
  } catch (err) {
    res.redirect('/admin/collections?error=' + encodeURIComponent(err.message) + '#collection-' + collectionId);
  }
});

// Delete
router.post('/:id/delete', (req, res) => {
  collections.delete(parseInt(req.params.id));
  saveDatabase();
  res.redirect('/admin/collections');
});

module.exports = router;
