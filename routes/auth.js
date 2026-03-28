'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const {
  usersAsync,
  userInvitesAsync,
  userCollectionAccessAsync,
  passwordResetTokensAsync,
  mfaRememberTokensAsync,
  settingsAsync
} = require('../database/db');
const { sendEmailOtp } = require('../utils/email');
const { generateOtpCode, verifyTotp } = require('../utils/mfa');
const { resolveApplicationSettings } = require('../utils/application-settings');

function consumeAuthError(req) {
  const error = req.session.authError || null;
  delete req.session.authError;
  return error;
}

function safeReturnTo(req) {
  let returnTo = req.session.returnTo || '/';
  delete req.session.returnTo;
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) {
    returnTo = '/';
  }
  return returnTo;
}

function completeLogin(req, res, next, user, returnTo) {
  req.session.regenerate((regenErr) => {
    if (regenErr) return next(regenErr);
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      delete req.session.pendingLogin;
      req.session.authenticatedAt = Date.now();
      res.redirect(returnTo || '/');
    });
  });
}

async function beginEmailMfa(req, user, returnTo) {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await usersAsync.storeEmailOtp(user.id, code, expiresAt);
  await sendEmailOtp(user, code);
  req.session.pendingLogin = { userId: user.id, returnTo, method: 'email' };
}

// ── Login ──────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('auth/login', {
    pageTitle: 'Sign In',
    error: consumeAuthError(req)
  });
});

router.post('/login',
  (req, res, next) => {
    passport.authenticate('local', async (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        // Special case: pending account — redirect to /pending page
        if (info?.message === 'pending') {
          return res.redirect('/pending');
        }
        req.session.authError = info?.message || 'Invalid credentials.';
        return res.redirect('/login');
      }
      const returnTo = safeReturnTo(req);

      // Check "remember this computer" cookie to skip MFA
      if (user.mfa_method && req.signedCookies?.mfa_remember) {
        const tokenHash = crypto.createHash('sha256').update(req.signedCookies.mfa_remember).digest('hex');
        const remembered = await mfaRememberTokensAsync.verify(user.id, tokenHash);
        if (remembered) {
          return completeLogin(req, res, next, user, returnTo);
        }
      }

      if (user.mfa_method === 'email') {
        return beginEmailMfa(req, user, returnTo)
          .then(() => res.redirect('/login/mfa'))
          .catch((mfaErr) => {
            req.session.authError = mfaErr.message || 'Could not send email verification code.';
            res.redirect('/login');
          });
      }
      if (user.mfa_method === 'totp') {
        req.session.pendingLogin = { userId: user.id, returnTo, method: 'totp' };
        return res.redirect('/login/mfa');
      }
      completeLogin(req, res, next, user, returnTo);
    })(req, res, next);
  }
);

router.get('/login/mfa', async (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  const pending = req.session.pendingLogin;
  if (!pending?.userId) return res.redirect('/login');

  const user = await usersAsync.findById(pending.userId);
  if (!user) {
    delete req.session.pendingLogin;
    req.session.authError = 'Your sign-in session expired. Please try again.';
    return res.redirect('/login');
  }

  const maskedEmail = user.email
    ? user.email.replace(/^(.)(.*)(@.*)$/, (_, first, middle, domain) => {
        const maskedMiddle = middle.length > 2 ? `${middle[0]}${'•'.repeat(Math.max(middle.length - 2, 1))}${middle[middle.length - 1]}` : '••';
        return `${first}${maskedMiddle}${domain}`;
      })
    : null;

  res.render('auth/mfa', {
    pageTitle: 'Verify Sign-In',
    error: consumeAuthError(req),
    method: pending.method,
    maskedEmail
  });
});

router.post('/login/mfa', async (req, res, next) => {
  const pending = req.session.pendingLogin;
  if (!pending?.userId) {
    req.session.authError = 'Your sign-in session expired. Please try again.';
    return res.redirect('/login');
  }

  const user = await usersAsync.findById(pending.userId);
  if (!user) {
    delete req.session.pendingLogin;
    req.session.authError = 'Your sign-in session expired. Please try again.';
    return res.redirect('/login');
  }

  const code = (req.body.code || '').trim();
  let valid = false;

  if (pending.method === 'email') {
    valid = await usersAsync.verifyEmailOtp(user.id, code);
    if (valid) {
      await usersAsync.clearEmailOtp(user.id);
    }
  } else if (pending.method === 'totp') {
    valid = verifyTotp(await usersAsync.getTotpSecret(user.id), code);
  }

  if (!valid) {
    req.session.authError = 'That verification code was not valid.';
    return res.redirect('/login/mfa');
  }

  // Set "remember this computer" cookie if requested
  if (req.body.remember_device) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await mfaRememberTokensAsync.create(user.id, tokenHash, expiresAt);
    res.cookie('mfa_remember', rawToken, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
  }

  const returnTo = pending.returnTo || '/';
  delete req.session.pendingLogin;
  completeLogin(req, res, next, user, returnTo);
});

router.post('/login/mfa/resend', async (req, res) => {
  const pending = req.session.pendingLogin;
  if (!pending?.userId || pending.method !== 'email') {
    return res.redirect('/login');
  }

  const user = await usersAsync.findById(pending.userId);
  if (!user) {
    delete req.session.pendingLogin;
    req.session.authError = 'Your sign-in session expired. Please try again.';
    return res.redirect('/login');
  }

  try {
    await beginEmailMfa(req, user, pending.returnTo || '/');
  } catch (err) {
    req.session.authError = err.message || 'Could not resend the email verification code.';
  }
  res.redirect('/login/mfa');
});

// ── Logout ─────────────────────────────────────────────────────────────────

router.post('/logout', (req, res, next) => {
  res.clearCookie('mfa_remember');
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
    error: consumeAuthError(req)
  });
});

router.get('/terms', async (req, res) => {
  const cfg = await settingsAsync.getAll();
  const applicationSettings = resolveApplicationSettings(cfg);
  res.render('policy', {
    pageTitle: 'Terms of Service',
    title: 'Terms of Service',
    subtitle: 'The terms governing use of this site.',
    content: applicationSettings.termsOfService
  });
});

router.get('/privacy', async (req, res) => {
  const cfg = await settingsAsync.getAll();
  const applicationSettings = resolveApplicationSettings(cfg);
  res.render('policy', {
    pageTitle: 'Privacy Policy',
    title: 'Privacy Policy',
    subtitle: 'How this application handles the information stored in it.',
    content: applicationSettings.privacyPolicy
  });
});

router.get('/data-security', async (req, res) => {
  const cfg = await settingsAsync.getAll();
  const applicationSettings = resolveApplicationSettings(cfg);
  res.render('policy', {
    pageTitle: 'Data Security',
    title: 'Data Security',
    subtitle: 'How this application approaches access control and system protection.',
    content: applicationSettings.dataSecurityInfo
  });
});

router.post('/register', async (req, res, next) => {
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
  if (await usersAsync.findByUsername(username)) {
    req.session.authError = 'That username is already taken.';
    return res.redirect('/register');
  }
  if (email && await usersAsync.findByEmail(email)) {
    req.session.authError = 'That email address is already associated with an account.';
    return res.redirect('/register');
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const isFirst = await usersAsync.count() === 0;
  // First registered user becomes admin and is immediately active
  const role   = isFirst ? 'admin' : 'user';
  const status = isFirst ? 'active' : 'pending';
  let id;
  try {
    id = await usersAsync.create({
      username,
      email,
      passwordHash,
      role,
      status,
      accessAll: isFirst,
      canUseSystemApiKeys: isFirst
    });
  } catch (err) {
    if ((err.message || '').includes('users.email')) {
      req.session.authError = 'That email address is already associated with an account.';
      return res.redirect('/register');
    }
    return next(err);
  }

  if (!isFirst) {
    // Show pending page — do not auto-login
    return res.redirect('/pending');
  }

  const user = await usersAsync.findById(id);
  completeLogin(req, res, () => {
    req.session.authError = 'Account created — please sign in.';
    return res.redirect('/login');
  }, user, '/');
});

// ── Pending approval ───────────────────────────────────────────────────────

router.get('/pending', (req, res) => {
  // If somehow an active user lands here, redirect home
  if (req.isAuthenticated() && req.user.status === 'active') {
    return res.redirect('/');
  }
  res.render('auth/pending', { pageTitle: 'Account Pending' });
});

router.get('/invite/:token', async (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');

  const token = String(req.params.token || '');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const invite = await userInvitesAsync.findByTokenHash(tokenHash);

  if (!invite || invite.revoked_at || invite.accepted_at || new Date(invite.expires_at).getTime() < Date.now()) {
    return res.status(404).render('error', { message: 'That invitation is no longer valid.', error: {} });
  }

  res.render('auth/invite', {
    pageTitle: 'Accept Invitation',
    invite,
    token,
    error: consumeAuthError(req)
  });
});

router.post('/invite/:token', async (req, res, next) => {
  const token = String(req.params.token || '');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const invite = await userInvitesAsync.findByTokenHash(tokenHash);

  if (!invite || invite.revoked_at || invite.accepted_at || new Date(invite.expires_at).getTime() < Date.now()) {
    return res.status(404).render('error', { message: 'That invitation is no longer valid.', error: {} });
  }

  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  const confirm = req.body.confirm || '';

  if (!username || !password) {
    req.session.authError = 'Username and password are required.';
    return res.redirect(`/invite/${token}`);
  }
  if (username.length < 3 || !/^[a-z0-9_.-]+$/.test(username)) {
    req.session.authError = 'Username must be at least 3 characters and contain only letters, numbers, _ . -';
    return res.redirect(`/invite/${token}`);
  }
  if (password.length < 8) {
    req.session.authError = 'Password must be at least 8 characters.';
    return res.redirect(`/invite/${token}`);
  }
  if (password !== confirm) {
    req.session.authError = 'Passwords do not match.';
    return res.redirect(`/invite/${token}`);
  }
  if (await usersAsync.findByUsername(username)) {
    req.session.authError = 'That username is already taken.';
    return res.redirect(`/invite/${token}`);
  }
  if (invite.email && await usersAsync.findByEmail(invite.email)) {
    req.session.authError = 'That invited email address already belongs to an account.';
    return res.redirect(`/invite/${token}`);
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  let userId;
  try {
    userId = await usersAsync.create({
      username,
      email: invite.email,
      passwordHash,
      role: invite.role,
      status: 'active',
      accessAll: !!invite.access_all,
      canUseSystemApiKeys: !!invite.can_use_system_api_keys,
      inviteId: invite.id
    });

    if (!invite.access_all) {
      // Use per-collection roles if available, otherwise fall back to basic access
      let collectionRoles = null;
      if (invite.collection_roles) {
        try { collectionRoles = JSON.parse(invite.collection_roles); } catch (e) {}
      }
      if (collectionRoles && Object.keys(collectionRoles).length > 0) {
        await userCollectionAccessAsync.setForUserWithRoles(userId, collectionRoles);
      } else {
        await userCollectionAccessAsync.setForUser(userId, invite.collection_ids || []);
      }
    }
    await userInvitesAsync.markAccepted(invite.id, userId);
  } catch (err) {
    return next(err);
  }

  const user = await usersAsync.findById(userId);
  completeLogin(req, res, () => {
    req.session.authError = 'Account created — please sign in.';
    return res.redirect('/login');
  }, user, '/');
});

router.get('/reset-password/:token', async (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');

  const token = String(req.params.token || '');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const reset = await passwordResetTokensAsync.findByTokenHash(tokenHash);

  if (!reset || reset.used_at || reset.revoked_at || new Date(reset.expires_at).getTime() < Date.now()) {
    return res.status(404).render('error', { message: 'That password reset link is no longer valid.', error: {} });
  }

  res.render('auth/reset-password', {
    pageTitle: 'Reset Password',
    token,
    username: reset.username,
    error: consumeAuthError(req)
  });
});

router.post('/reset-password/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const reset = await passwordResetTokensAsync.findByTokenHash(tokenHash);

  if (!reset || reset.used_at || reset.revoked_at || new Date(reset.expires_at).getTime() < Date.now()) {
    return res.status(404).render('error', { message: 'That password reset link is no longer valid.', error: {} });
  }

  const password = req.body.password || '';
  const confirm = req.body.confirm || '';

  if (password.length < 8) {
    req.session.authError = 'Password must be at least 8 characters.';
    return res.redirect(`/reset-password/${token}`);
  }
  if (password !== confirm) {
    req.session.authError = 'Passwords do not match.';
    return res.redirect(`/reset-password/${token}`);
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  await usersAsync.updatePassword(reset.user_id, passwordHash);
  await usersAsync.updatePasswordChangedAt(reset.user_id);
  await passwordResetTokensAsync.markUsed(reset.id);
  await passwordResetTokensAsync.revokeForUser(reset.user_id);

  req.session.authError = 'Your password has been reset. Please sign in.';
  res.redirect('/login');
});

module.exports = router;
