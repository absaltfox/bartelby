'use strict';

const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { usersAsync, userCollectionAccessAsync, roleAtLeast } = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');

let bcryptModule = null;
const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function getBcrypt() {
  if (!bcryptModule) {
    bcryptModule = require('bcryptjs');
  }
  return bcryptModule;
}

function parsePasswordChangedTimestamp(value) {
  if (value == null) return NaN;

  const raw = String(value).trim();
  if (!raw) return NaN;

  const candidate = SQLITE_UTC_TIMESTAMP_RE.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;

  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? NaN : parsed;
}

// ── Passport strategy ──────────────────────────────────────────────────────

passport.use(new LocalStrategy(
  { usernameField: 'username', passwordField: 'password' },
  async (username, password, done) => {
    try {
      const user = await usersAsync.findByUsername(username.trim().toLowerCase());
      if (!user) {
        return done(null, false, { message: 'Invalid username or password.' });
      }
      const match = getBcrypt().compareSync(password, user.password_hash);
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
async function locals(req, res, next) {
  try {
    // Invalidate session if password was changed after authentication.
    // Normalize only naive SQLite UTC timestamps; keep ISO timestamps with an
    // explicit timezone untouched so we do not corrupt valid offsets.
    if (req.isAuthenticated() && req.user.password_changed_at && req.session.authenticatedAt) {
      const changedAt = parsePasswordChangedTimestamp(req.user.password_changed_at);
      if (Number.isNaN(changedAt)) {
        console.warn(`[auth] Could not parse password_changed_at for user ${req.user.id}.`);
      } else if (changedAt > req.session.authenticatedAt) {
        return req.logout((err) => {
          if (err) return next(err);
          req.session.authError = 'Your password was changed. Please sign in again.';
          return res.redirect('/login');
        });
      }
    }
    res.locals.currentUser = req.user || null;
    res.locals.isAdmin = req.user?.role === 'admin';
    // Resolve manager status synchronously before next() so templates always
    // see a stable boolean value — never undefined from a late-firing promise.
    if (req.user && req.user.role !== 'admin') {
      try {
        const ids = await userCollectionAccessAsync.getManagerCollectionIds(req.user.id);
        res.locals.managedCollectionIds = ids;
        res.locals.isManager = ids.length > 0;
      } catch {
        res.locals.managedCollectionIds = [];
        res.locals.isManager = false;
      }
    } else {
      res.locals.isManager = false;
      res.locals.managedCollectionIds = [];
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Allow unauthenticated visitors through (for world-public content) */
function optionalAuth(req, res, next) {
  if (!req.isAuthenticated()) return next();
  if (req.user.status === 'pending') return res.redirect('/pending');
  if (req.user.status === 'rejected') {
    req.logout((err) => {});
    req.session.authError = 'Your account request was not approved.';
    return res.redirect('/login');
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
  return asyncHandler(async (req, res, next) => {
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
  });
}

/** Require at least the given role on any collection the document belongs to */
function requireDocumentRole(minRole) {
  return asyncHandler(async (req, res, next) => {
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
  });
}

/** Allow admins or users who manage at least one collection */
const requireAdminOrManager = asyncHandler(async (req, res, next) => {
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
});

// Shared shape consumed by the access-conditions builders and by the
// sentiment research model. Any route needing { userId, isAdmin, accessAll }
// should call this rather than re-deriving from req.user — keeps the
// access-all model singly owned.
function buildAccessOpts(req) {
  const u = (req && req.user) || null;
  return {
    userId: u ? u.id : null,
    isAdmin: u ? u.role === 'admin' : false,
    accessAll: u ? !!u.access_all : false
  };
}

module.exports = {
  passport,
  locals,
  parsePasswordChangedTimestamp,
  requireAuth,
  optionalAuth,
  requireAuthApi,
  requireAdmin,
  requireCollectionRole,
  requireDocumentRole,
  requireAdminOrManager,
  buildAccessOpts
};
