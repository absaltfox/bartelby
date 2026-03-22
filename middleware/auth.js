'use strict';

const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { usersAsync } = require('../database/db');

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
  res.locals.currentUser = req.user || null;
  res.locals.isAdmin = req.user?.role === 'admin';
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

module.exports = { passport, locals, requireAuth, requireAuthApi, requireAdmin };
