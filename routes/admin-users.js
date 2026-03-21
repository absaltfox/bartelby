'use strict';

const express = require('express');
const router = express.Router();
const { users, collections, userCollectionAccess, saveDatabase } = require('../database/db');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// List all users (pending + active + rejected)
router.get('/', (req, res) => {
  const allUsers = users.getAll();
  const pending  = allUsers.filter(u => u.status === 'pending');
  const active   = allUsers.filter(u => u.status === 'active');
  const rejected = allUsers.filter(u => u.status === 'rejected');

  res.render('admin/users', {
    pageTitle: 'User Management',
    pending,
    active,
    rejected,
    currentUserId: req.user.id
  });
});

// Approval form
router.get('/:id/approve', (req, res) => {
  const id = parseInt(req.params.id);
  const user = users.findById(id);
  if (!user) return res.redirect('/admin/users');

  const allCollections = collections.getAll();
  res.render('admin/approve-user', {
    pageTitle: `Approve ${user.username}`,
    approveUser: user,
    allCollections
  });
});

// Process approval
router.post('/:id/approve', (req, res) => {
  const id = parseInt(req.params.id);
  const role      = req.body.role === 'admin' ? 'admin' : 'user';
  const accessAll = req.body.access_all === '1';
  const collectionIds = Array.isArray(req.body.collections)
    ? req.body.collections.map(Number)
    : (req.body.collections ? [Number(req.body.collections)] : []);

  users.approve(id, { role, accessAll });
  if (!accessAll) {
    userCollectionAccess.setForUser(id, collectionIds);
  }
  saveDatabase();
  res.redirect('/admin/users');
});

// Reject
router.post('/:id/reject', (req, res) => {
  const id = parseInt(req.params.id);
  users.reject(id);
  saveDatabase();
  res.redirect('/admin/users');
});

// Change role (for active users)
router.post('/:id/role', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.redirect('/admin/users');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  users.setRole(id, role);
  saveDatabase();
  res.redirect('/admin/users');
});

// Edit access for active user
router.get('/:id/access', (req, res) => {
  const id = parseInt(req.params.id);
  const user = users.findById(id);
  if (!user || id === req.user.id) return res.redirect('/admin/users');

  const allCollections = collections.getAll();
  const grantedIds = userCollectionAccess.getIdsByUserId(id);
  res.render('admin/approve-user', {
    pageTitle: `Edit Access — ${user.username}`,
    approveUser: user,
    allCollections,
    grantedIds,
    editMode: true
  });
});

router.post('/:id/access', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.redirect('/admin/users');

  const accessAll = req.body.access_all === '1';
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const collectionIds = Array.isArray(req.body.collections)
    ? req.body.collections.map(Number)
    : (req.body.collections ? [Number(req.body.collections)] : []);

  users.setRole(id, role);
  users.setAccessAll(id, accessAll);
  if (!accessAll) {
    userCollectionAccess.setForUser(id, collectionIds);
  }
  saveDatabase();
  res.redirect('/admin/users');
});

// Delete
router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.redirect('/admin/users');
  users.delete(id);
  saveDatabase();
  res.redirect('/admin/users');
});

module.exports = router;
