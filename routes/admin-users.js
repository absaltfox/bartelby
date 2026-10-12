'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const {
  usersAsync,
  collectionsAsync,
  userCollectionAccessAsync,
  userInvitesAsync,
  passwordResetTokensAsync,
  mfaRememberTokensAsync
} = require('../database/db');
const { requireAdmin } = require('../middleware/auth');
const { isSmtpConfigured, sendInviteEmail, sendPasswordResetEmail } = require('../utils/email');
const { absoluteAppUrl } = require('../utils/app-url');
const audit = require('../utils/audit-log');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAdmin);

// Rate limit sensitive token-generation endpoints per acting admin (3 per hour).
// Prevents an admin account (if compromised) from flooding users with emails.
const tokenGenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `admin-token-gen:${req.user?.id ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many token generation requests. Please wait before sending more.'
});

function consumeFlash(req) {
  const flash = req.session.adminUsersFlash || null;
  delete req.session.adminUsersFlash;
  return flash;
}

// Single-use submit tokens for the two forms that mint a link. Their result is
// rendered in the POST response (see renderOneTimeLink), which leaves the POST
// as the page's last navigation, so a browser refresh sends it again. A repeat
// would mint a second invitation, or a second reset token that revokes the link
// the admin had just copied. Each rendered form carries a token that is spent
// on first use; a repeat is redirected and creates nothing.
const SUBMIT_TOKEN_LIMIT = 20;
const ALREADY_SUBMITTED_MESSAGE = 'That form was already submitted. Nothing new was created.';

function issueSubmitToken(req) {
  const token = crypto.randomBytes(16).toString('hex');
  const tokens = Array.isArray(req.session.adminUsersSubmitTokens)
    ? req.session.adminUsersSubmitTokens
    : [];
  // Bounded: every page render issues one, and most are never spent.
  req.session.adminUsersSubmitTokens = [...tokens, token].slice(-SUBMIT_TOKEN_LIMIT);
  return token;
}

function requireUnspentSubmitToken(req, res, next) {
  const supplied = typeof req.body._once === 'string' ? req.body._once : '';
  const tokens = Array.isArray(req.session.adminUsersSubmitTokens)
    ? req.session.adminUsersSubmitTokens
    : [];
  if (!supplied || !tokens.includes(supplied)) {
    req.session.adminUsersFlash = { error: ALREADY_SUBMITTED_MESSAGE };
    return res.redirect('/admin/users');
  }
  req.session.adminUsersSubmitTokens = tokens.filter((token) => token !== supplied);
  next();
}

function parseCollectionIds(raw) {
  return Array.isArray(raw)
    ? raw.map(Number).filter(Number.isInteger)
    : (raw ? [Number(raw)].filter(Number.isInteger) : []);
}

async function blockLastActiveAdminRemoval(req, {
  targetUserId,
  nextRole = null,
  deleting = false,
  action = null
}) {
  const target = await usersAsync.findById(targetUserId);
  if (!target || target.role !== 'admin' || target.status !== 'active') {
    return false;
  }

  if (!deleting && nextRole === 'admin') {
    return false;
  }

  const adminCount = await usersAsync.countActiveAdmins();
  if (adminCount > 1) {
    return false;
  }

  const verb = action || (deleting ? 'delete' : 'demote');
  req.session.adminUsersFlash = {
    error: `Cannot ${verb} the last active administrator.`
  };
  return true;
}

async function renderUsersPage(req, res, flash) {
  const allUsers = await usersAsync.getAll();
  const pending  = allUsers.filter(u => u.status === 'pending');
  const active   = allUsers.filter(u => u.status === 'active');
  const rejected = allUsers.filter(u => u.status === 'rejected');

  res.render('admin/users', {
    pageTitle: 'User Management',
    pending,
    active,
    rejected,
    invites: await userInvitesAsync.getActive(),
    currentUserId: req.user.id,
    flash,
    submitToken: issueSubmitToken(req),
    smtpConfigured: isSmtpConfigured()
  });
}

// A freshly minted invite or reset link is a live bearer token, and the
// database only keeps its hash, so this response is the one chance to show it.
// Render it directly instead of redirecting through the session flash: a flash
// the admin never comes back to read would leave the token in the session
// store for the cookie's whole lifetime.
async function renderOneTimeLink(req, res, flash) {
  res.set('Cache-Control', 'no-store');
  await renderUsersPage(req, res, flash);
}

// List all users (pending + active + rejected)
router.get('/', asyncHandler(async (req, res) => {
  await renderUsersPage(req, res, consumeFlash(req));
}));

router.get('/invite', asyncHandler(async (req, res) => {
  res.render('admin/invite-user', {
    pageTitle: 'Invite User',
    allCollections: await collectionsAsync.getAll(),
    smtpConfigured: isSmtpConfigured(),
    submitToken: issueSubmitToken(req),
    error: req.session.authError || null
  });
  delete req.session.authError;
}));

// The submit-token check runs first so a refresh does not spend limiter budget.
router.post('/invite', requireUnspentSubmitToken, tokenGenLimiter, asyncHandler(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const accessAll = req.body.access_all === '1';
  const canUseSystemApiKeys = req.body.can_use_system_api_keys === '1' || role === 'admin';
  const collectionIds = parseCollectionIds(req.body.collections);

  // Build per-collection role map from collection_role_* fields
  const collectionRoles = {};
  for (const cid of collectionIds) {
    collectionRoles[cid] = req.body[`collection_role_${cid}`] || 'viewer';
  }

  if (!email) {
    req.session.authError = 'Email is required to send or create an invitation.';
    return res.redirect('/admin/users/invite');
  }
  if (await usersAsync.findByEmail(email)) {
    req.session.authError = 'That email address already belongs to an existing account.';
    return res.redirect('/admin/users/invite');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const inviteId = await userInvitesAsync.create({
    email,
    tokenHash,
    role,
    accessAll,
    canUseSystemApiKeys,
    collectionIds,
    collectionRoles,
    invitedBy: req.user.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });

  const inviteUrl = absoluteAppUrl(req, `/invite/${token}`);
  let message = `Invitation created for ${email}.`;
  let delivered = false;

  if (isSmtpConfigured()) {
    try {
      await sendInviteEmail({
        email,
        inviteUrl,
        invitedBy: req.user.username
      });
      message = `Invitation created and emailed to ${email}.`;
      delivered = true;
    } catch (err) {
      message = `Invitation created for ${email}, but the email could not be sent: ${err.message}`;
    }
  }

  audit.log('user.invite_created', { ...audit.reqContext(req), inviteeEmail: email, role });
  if (!delivered) {
    return renderOneTimeLink(req, res, { type: 'invite', inviteId, message, inviteUrl });
  }
  req.session.adminUsersFlash = {
    type: 'invite',
    inviteId,
    message
  };
  res.redirect('/admin/users');
}));

// Approval form
router.get('/:id/approve', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const user = await usersAsync.findById(id);
  if (!user) return res.redirect('/admin/users');

  const allCollections = await collectionsAsync.getAll();
  res.render('admin/approve-user', {
    pageTitle: `Approve ${user.username}`,
    approveUser: user,
    allCollections,
    grantedIds: [],
    grantedRoles: {},
    editMode: false
  });
}));

// Process approval
router.post('/:id/approve', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const role      = req.body.role === 'admin' ? 'admin' : 'user';
  const accessAll = req.body.access_all === '1';
  const canUseSystemApiKeys = req.body.can_use_system_api_keys === '1' || role === 'admin';
  const collectionIds = parseCollectionIds(req.body.collections);

  await usersAsync.approve(id, { role, accessAll, canUseSystemApiKeys });
  if (!accessAll) {
    const collectionRoles = {};
    for (const cid of collectionIds) {
      collectionRoles[cid] = req.body[`collection_role_${cid}`] || 'viewer';
    }
    await userCollectionAccessAsync.setForUserWithRoles(id, collectionRoles);
  }
  audit.log('user.approved', { ...audit.reqContext(req), targetUserId: id, role, accessAll });
  res.redirect('/admin/users');
}));

// Reject
//
// Carries the same two guards as every sibling mutation (/:id/role, /:id/access,
// /:id/delete). Rejection now evicts the target's live sessions and
// LocalStrategy refuses a rejected account at login, so a self-reject or a
// last-admin reject is unrecoverable without direct database access — /setup is
// gated on there being zero users. Before sessions were evicted this was merely
// survivable; it no longer is.
router.post('/:id/reject', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.redirect('/admin/users');
  if (await blockLastActiveAdminRemoval(req, {
    targetUserId: id,
    deleting: true,
    action: 'reject'
  })) {
    return res.redirect('/admin/users');
  }
  await usersAsync.reject(id);
  audit.log('user.rejected', { ...audit.reqContext(req), targetUserId: id });
  res.redirect('/admin/users');
}));

// Change role (for active users)
router.post('/:id/role', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.redirect('/admin/users');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (await blockLastActiveAdminRemoval(req, {
    targetUserId: id,
    nextRole: role
  })) {
    return res.redirect('/admin/users');
  }
  await usersAsync.setRole(id, role);
  audit.log('user.role_changed', { ...audit.reqContext(req), targetUserId: id, role });
  res.redirect('/admin/users');
}));

// Edit access for active user
router.get('/:id/access', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const user = await usersAsync.findById(id);
  if (!user || id === req.user.id) return res.redirect('/admin/users');

  const allCollections = await collectionsAsync.getAll();
  const grants = await userCollectionAccessAsync.getWithRolesByUserId(id);
  const grantedIds = grants.map(g => g.collection_id);
  const grantedRoles = {};
  grants.forEach(g => { grantedRoles[g.collection_id] = g.role; });
  res.render('admin/approve-user', {
    pageTitle: `Edit Access — ${user.username}`,
    approveUser: user,
    allCollections,
    grantedIds,
    grantedRoles,
    editMode: true
  });
}));

router.post('/:id/access', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.redirect('/admin/users');

  const accessAll = req.body.access_all === '1';
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const canUseSystemApiKeys = req.body.can_use_system_api_keys === '1' || role === 'admin';
  const collectionIds = parseCollectionIds(req.body.collections);

  if (await blockLastActiveAdminRemoval(req, {
    targetUserId: id,
    nextRole: role
  })) {
    return res.redirect('/admin/users');
  }

  await usersAsync.setRole(id, role);
  await usersAsync.setAccessAll(id, accessAll);
  await usersAsync.setCanUseSystemApiKeys(id, canUseSystemApiKeys);
  if (!accessAll) {
    // Build role map from collection_role_* fields
    const collectionRoles = {};
    for (const cid of collectionIds) {
      collectionRoles[cid] = req.body[`collection_role_${cid}`] || 'viewer';
    }
    await userCollectionAccessAsync.setForUserWithRoles(id, collectionRoles);
  }
  audit.log('user.access_updated', { ...audit.reqContext(req), targetUserId: id, role, accessAll });
  res.redirect('/admin/users');
}));

router.post('/invites/:id/revoke', asyncHandler(async (req, res) => {
  await userInvitesAsync.revoke(parseInt(req.params.id, 10));
  res.redirect('/admin/users');
}));

router.post('/:id/password-reset', requireUnspentSubmitToken, tokenGenLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.redirect('/admin/users');

  const user = await usersAsync.findById(id);
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
  await mfaRememberTokensAsync.deleteForUser(user.id);
  await passwordResetTokensAsync.create({
    userId: user.id,
    tokenHash,
    createdBy: req.user.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });

  const resetUrl = absoluteAppUrl(req, `/reset-password/${token}`);
  let message = `Password reset link created for ${user.username}.`;
  let delivered = false;

  if (isSmtpConfigured()) {
    try {
      await sendPasswordResetEmail({
        email: user.email,
        username: user.username,
        resetUrl,
        initiatedBy: req.user.username
      });
      message = `Password reset email sent to ${user.email}.`;
      delivered = true;
    } catch (err) {
      message = `Password reset link created for ${user.username}, but the email could not be sent: ${err.message}`;
    }
  }

  audit.log('user.password_reset_initiated', { ...audit.reqContext(req), targetUserId: user.id, targetEmail: user.email });
  if (!delivered) {
    return renderOneTimeLink(req, res, { type: 'password-reset', message, resetUrl });
  }
  req.session.adminUsersFlash = {
    type: 'password-reset',
    message
  };
  res.redirect('/admin/users');
}));

// Delete
router.post('/:id/delete', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.redirect('/admin/users');
  if (await blockLastActiveAdminRemoval(req, {
    targetUserId: id,
    deleting: true
  })) {
    return res.redirect('/admin/users');
  }
  try {
    await usersAsync.delete(id);
    audit.log('user.deleted', { ...audit.reqContext(req), targetUserId: id });
  } catch (err) {
    console.error(`Failed to delete user ${id}:`, err.message);
    req.session.adminUsersFlash = { error: 'Failed to delete user. They may have associated records.' };
  }
  res.redirect('/admin/users');
}));

module.exports = router;
