'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const passport = require('passport');
const { users } = require('../database/db');

// ── Login ──────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('auth/login', {
    pageTitle: 'Sign In',
    error: req.session.authError || null
  });
  delete req.session.authError;
});

router.post('/login',
  (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        // Special case: pending account — redirect to /pending page
        if (info?.message === 'pending') {
          return res.redirect('/pending');
        }
        req.session.authError = info?.message || 'Invalid credentials.';
        return res.redirect('/login');
      }
      req.logIn(user, (err) => {
        if (err) return next(err);
        const returnTo = req.session.returnTo || '/';
        delete req.session.returnTo;
        res.redirect(returnTo);
      });
    })(req, res, next);
  }
);

// ── Logout ─────────────────────────────────────────────────────────────────

router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

// ── Register ───────────────────────────────────────────────────────────────

router.get('/register', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('auth/register', {
    pageTitle: 'Create Account',
    error: req.session.authError || null
  });
  delete req.session.authError;
});

router.post('/register', (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const email    = (req.body.email    || '').trim().toLowerCase() || null;
  const password =  req.body.password || '';
  const confirm  =  req.body.confirm  || '';

  if (!username || !password) {
    req.session.authError = 'Username and password are required.';
    return res.redirect('/register');
  }
  if (username.length < 3 || !/^[a-z0-9_.-]+$/.test(username)) {
    req.session.authError = 'Username must be at least 3 characters and contain only letters, numbers, _ . -';
    return res.redirect('/register');
  }
  if (password.length < 8) {
    req.session.authError = 'Password must be at least 8 characters.';
    return res.redirect('/register');
  }
  if (password !== confirm) {
    req.session.authError = 'Passwords do not match.';
    return res.redirect('/register');
  }
  if (users.findByUsername(username)) {
    req.session.authError = 'That username is already taken.';
    return res.redirect('/register');
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const isFirst = users.count() === 0;
  // First registered user becomes admin and is immediately active
  const role   = isFirst ? 'admin' : 'user';
  const status = isFirst ? 'active' : 'pending';
  const id = users.create({ username, email, passwordHash, role, status });

  if (!isFirst) {
    // Show pending page — do not auto-login
    return res.redirect('/pending');
  }

  const user = users.findById(id);
  req.logIn(user, (err) => {
    if (err) {
      req.session.authError = 'Account created — please sign in.';
      return res.redirect('/login');
    }
    res.redirect('/');
  });
});

// ── Pending approval ───────────────────────────────────────────────────────

router.get('/pending', (req, res) => {
  // If somehow an active user lands here, redirect home
  if (req.isAuthenticated() && req.user.status === 'active') {
    return res.redirect('/');
  }
  res.render('auth/pending', { pageTitle: 'Account Pending' });
});

module.exports = router;
