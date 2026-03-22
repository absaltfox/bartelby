'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { users, collections, userCollectionAccess, userInvites, passwordResetTokens, saveDatabase } = require('../database/db');
const { requireAdmin } = require('../middleware/auth');
const { isSmtpConfigured, sendInviteEmail, sendPasswordResetEmail } = require('../utils/email');

router.use(requireAdmin);

function consumeFlash(req) {
  const flash = req.session.adminUsersFlash || null;
  delete req.session.adminUsersFlash;
  return flash;
}

function parseCollectionIds(raw) {
  return Array.isArray(raw)
    ? raw.map(Number).filter(Number.isInteger)
    : (raw ? [Number(raw)].filter(Number.isInteger) : []);
}

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
    invites: userInvites.getActive(),
    currentUserId: req.user.id,
    flash: consumeFlash(req),
    smtpConfigured: isSmtpConfigured()
  });
});

router.get('/invite', (req, res) => {
  res.render('admin/invite-user', {
    pageTitle: 'Invite User',
    allCollections: collections.getAll(),
    smtpConfigured: isSmtpConfigured(),
    error: req.session.authError || null
  });
  delete req.session.authError;
});

router.post('/invite', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const accessAll = req.body.access_all === '1';
  const canUseSystemApiKeys = req.body.can_use_system_api_keys === '1' || role === 'admin';
  const collectionIds = parseCollectionIds(req.body.collections);

  if (!email) {
    req.session.authError = 'Email is required to send or create an invitation.';
    return res.redirect('/admin/users/invite');
  }
  if (users.findByEmail(email)) {
    req.session.authError = 'That email address already belongs to an existing account.';
    return res.redirect('/admin/users/invite');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const inviteId = userInvites.create({
    email,
    tokenHash,
    role,
    accessAll,
    canUseSystemApiKeys,
    collectionIds,
    invitedBy: req.user.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  saveDatabase();

  const inviteUrl = `${req.protocol}://${req.get('host')}/invite/${token}`;
  let message = `Invitation created for ${email}.`;

  if (isSmtpConfigured()) {
    try {
      await sendInviteEmail({
        email,
        inviteUrl,
        invitedBy: req.user.username
      });
      message = `Invitation created and emailed to ${email}.`;
    } catch (err) {
      message = `Invitation created for ${email}, but the email could not be sent: ${err.message}`;
    }
  }

  req.session.adminUsersFlash = {
    type: 'invite',
    inviteId,
    message,
    inviteUrl
  };
  res.redirect('/admin/users');
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
  const canUseSystemApiKeys = req.body.can_use_system_api_keys === '1' || role === 'admin';
  const collectionIds = parseCollectionIds(req.body.collections);

  users.approve(id, { role, accessAll, canUseSystemApiKeys });
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
  const canUseSystemApiKeys = req.body.can_use_system_api_keys === '1' || role === 'admin';
  const collectionIds = parseCollectionIds(req.body.collections);

  users.setRole(id, role);
  users.setAccessAll(id, accessAll);
  users.setCanUseSystemApiKeys(id, canUseSystemApiKeys);
  if (!accessAll) {
    userCollectionAccess.setForUser(id, collectionIds);
  }
  saveDatabase();
  res.redirect('/admin/users');
});

router.post('/invites/:id/revoke', (req, res) => {
  userInvites.revoke(parseInt(req.params.id, 10));
  saveDatabase();
  res.redirect('/admin/users');
});

router.post('/:id/password-reset', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.redirect('/admin/users');

  const user = users.findById(id);
  if (!user || user.status !== 'active') return res.redirect('/admin/users');
  if (!user.email) {
    req.session.adminUsersFlash = {
      type: 'password-reset',
      message: `No password reset link was created for ${user.username} because the account has no email address.`
    };
    return res.redirect('/admin/users');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  passwordResetTokens.create({
    userId: user.id,
    tokenHash,
    createdBy: req.user.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });
  saveDatabase();

  const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${token}`;
  let message = `Password reset link created for ${user.username}.`;

  if (isSmtpConfigured()) {
    try {
      await sendPasswordResetEmail({
        email: user.email,
        username: user.username,
        resetUrl,
        initiatedBy: req.user.username
      });
      message = `Password reset email sent to ${user.email}.`;
    } catch (err) {
      message = `Password reset link created for ${user.username}, but the email could not be sent: ${err.message}`;
    }
  }

  req.session.adminUsersFlash = {
    type: 'password-reset',
    message,
    resetUrl
  };
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
