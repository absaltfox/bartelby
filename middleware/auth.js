'use strict';

const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { usersAsync, userCollectionAccessAsync, roleAtLeast } = require('../database/db');

// ── Passport strategy ──────────────────────────────────────────────────────

passport.use(new LocalStrategy(
  { usernameField: 'username', passwordField: 'password' },
  async (username, password, done) => {
    try {
      const user = await usersAsync.findByUsername(username.trim().toLowerCase());
      if (!user) {
        return done(null, false, { message: 'Invalid username or password.' });
      }
      const match = bcrypt.compareSync(password, user.password_hash);
      if (!match) {
        return done(null, false, { message: 'Invalid username or password.' });
      }
      if (user.status === 'pending') {
        return done(null, false, { message: 'pending' });
      }
      if (user.status === 'rejected') {
        return done(null, false, { message: 'Your account request was not approved.' });
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await usersAsync.findById(id);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

// ── Middleware helpers ─────────────────────────────────────────────────────

/** Make req.user available in all EJS templates as `currentUser` */
function locals(req, res, next) {
  // Invalidate session if password was changed after authentication.
  // SQLite CURRENT_TIMESTAMP is UTC but lacks a timezone suffix, so we must
  // append 'Z' before parsing — otherwise JS treats it as local time.
  if (req.isAuthenticated() && req.user.password_changed_at && req.session.authenticatedAt) {
    const rawTs = String(req.user.password_changed_at).replace(' ', 'T') + 'Z';
    const changedAt = Date.parse(rawTs);
    if (!isNaN(changedAt) && changedAt > req.session.authenticatedAt) {
      return req.logout((err) => {
        if (err) return next(err);
        req.session.authError = 'Your password was changed. Please sign in again.';
        return res.redirect('/login');
      });
    }
  }
  res.locals.currentUser = req.user || null;
  res.locals.isAdmin = req.user?.role === 'admin';
  // Lazy-load manager status (set on first access via getter)
  if (req.user && req.user.role !== 'admin') {
    let _isManager = undefined;
    let _managedIds = undefined;
    Object.defineProperty(res.locals, 'isManager', {
      get: () => _isManager,
      enumerable: true
    });
    Object.defineProperty(res.locals, 'managedCollectionIds', {
      get: () => _managedIds,
      enumerable: true
    });
    // Pre-load for templates
    userCollectionAccessAsync.getManagerCollectionIds(req.user.id).then(ids => {
      _managedIds = ids;
      _isManager = ids.length > 0;
    }).catch(() => {
      _managedIds = [];
      _isManager = false;
    });
  } else {
    res.locals.isManager = false;
    res.locals.managedCollectionIds = [];
  }
  next();
}

/** Redirect unauthenticated or non-active requests to /login */
function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.user.status === 'pending') {
    return res.redirect('/pending');
  }
  if (req.user.status === 'rejected') {
    req.logout((err) => {});
    req.session.authError = 'Your account request was not approved.';
    return res.redirect('/login');
  }
  next();
}

/** Return 401 JSON for unauthenticated API requests */
function requireAuthApi(req, res, next) {
  if (!req.isAuthenticated() || req.user.status !== 'active') {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
}

/** Redirect non-admin requests to / with an error flash */
function requireAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.role === 'admin') return next();
  if (!req.isAuthenticated()) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  res.status(403).render('error', { message: 'Admin access required.', error: {} });
}

/** Require at least the given role on the collection identified by req.params */
function requireCollectionRole(minRole) {
  return async (req, res, next) => {
    if (!req.isAuthenticated()) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    if (req.user.role === 'admin') return next();
    const collectionId = parseInt(req.params.collectionId || req.params.id);
    if (isNaN(collectionId)) {
      return res.status(400).render('error', { message: 'Invalid collection.', error: {} });
    }
    const userRole = await userCollectionAccessAsync.getRoleForUser(req.user.id, collectionId);
    if (userRole && roleAtLeast(userRole, minRole)) return next();
    res.status(403).render('error', { message: 'You do not have permission for this action.', error: {} });
  };
}

/** Require at least the given role on any collection the document belongs to */
function requireDocumentRole(minRole) {
  return async (req, res, next) => {
    if (!req.isAuthenticated()) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    if (req.user.role === 'admin') return next();
    if (req.user.access_all && minRole === 'viewer') return next();
    const docId = parseInt(req.params.id || req.params.documentId);
    if (isNaN(docId)) {
      return res.status(400).render('error', { message: 'Invalid document.', error: {} });
    }
    const hasRole = await userCollectionAccessAsync.hasRoleOnDocumentCollections(req.user.id, docId, minRole);
    if (hasRole) return next();
    res.status(403).render('error', { message: 'You do not have permission for this action.', error: {} });
  };
}

/** Allow admins or users who manage at least one collection */
async function requireAdminOrManager(req, res, next) {
  if (!req.isAuthenticated()) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.user.role === 'admin') return next();
  const ids = await userCollectionAccessAsync.getManagerCollectionIds(req.user.id);
  if (ids.length > 0) {
    req.managedCollectionIds = ids;
    return next();
  }
  res.status(403).render('error', { message: 'Admin or collection manager access required.', error: {} });
}

module.exports = { passport, locals, requireAuth, requireAuthApi, requireAdmin, requireCollectionRole, requireDocumentRole, requireAdminOrManager };
