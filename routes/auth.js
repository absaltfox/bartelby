'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const passport = require('passport');
const {
  usersAsync,
  userInvitesAsync,
  userCollectionAccessAsync,
  passwordResetTokensAsync,
  mfaRememberTokensAsync,
  loginThrottlesAsync,
  settingsAsync
} = require('../database/db');
const { sendEmailOtp } = require('../utils/email');
const { generateOtpCode, verifyTotp } = require('../utils/mfa');
const { resolveApplicationSettings } = require('../utils/application-settings');
const { asyncHandler } = require('../utils/async-handler');
const { hashPassword } = require('../utils/passwords');
const { safeLocalPath } = require('../utils/safe-redirect');
const { requiresSecureTransport } = require('../utils/transport-security');
const { INVALID_CREDENTIALS_MESSAGE } = require('../middleware/auth');

function getBootstrapToken() {
  return String(process.env.BOOTSTRAP_ADMIN_TOKEN || '').trim();
}

async function getBootstrapStatus() {
  const userCount = await usersAsync.count();
  const bootstrapToken = getBootstrapToken();
  return {
    needsSetup: userCount === 0,
    configured: bootstrapToken.length > 0
  };
}

function constantTimeMatches(value, expected) {
  const left = Buffer.from(String(value || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function formatLockMessage(remainingMs) {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
  if (minutes < 60) {
    return `Too many verification attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  const hours = Math.ceil(minutes / 60);
  return `Too many verification attempts. Try again in about ${hours} hour${hours === 1 ? '' : 's'}.`;
}

function formatThrottleMessage(remainingMs) {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `Too many sign-in attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
}

function consumeAuthError(req) {
  const error = req.session.authError || null;
  delete req.session.authError;
  return error;
}

function safeReturnTo(req) {
  const returnTo = req.session.returnTo;
  delete req.session.returnTo;
  return safeLocalPath(returnTo, '/');
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

async function revokeRememberedDevicesForUser(res, userId) {
  await mfaRememberTokensAsync.deleteForUser(userId);
  res.clearCookie('mfa_remember');
}

async function beginEmailMfa(req, user, returnTo) {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await usersAsync.storeEmailOtp(user.id, code, expiresAt);
  await sendEmailOtp(user, code);
  req.session.pendingLogin = { userId: user.id, returnTo, method: 'email' };
}

// ── Login ──────────────────────────────────────────────────────────────────

router.get('/login', asyncHandler(async (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  const bootstrap = await getBootstrapStatus();
  res.render('auth/login', {
    pageTitle: 'Sign In',
    error: consumeAuthError(req),
    bootstrap
  });
}));

router.post('/login',
  // Escalating delay on repeated failures for one username (#101). Enforced on
  // arrival and answered at once: sleeping here would hold a socket open per
  // attempt, and checking before the password is verified means a throttled
  // attempt spends no bcrypt work. Keyed by the submitted username whether or
  // not it exists, so the wait says nothing about which accounts are real.
  asyncHandler(async (req, res, next) => {
    req.loginThrottleKey = loginThrottlesAsync.keyForUsername(req.body.username);
    const remaining = await loginThrottlesAsync.getRemainingMs(req.loginThrottleKey);
    if (remaining > 0) {
      req.session.authError = formatThrottleMessage(remaining);
      return res.redirect('/login');
    }
    next();
  }),
  (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      void Promise.resolve().then(async () => {
        if (err) throw err;
        if (!user) {
          // 'pending' and the not-approved message are only produced after the
          // password has matched, so neither is a failed guess.
          if (info?.message === 'pending') {
            await loginThrottlesAsync.clear(req.loginThrottleKey);
            return res.redirect('/pending');
          }
          if (info?.message === INVALID_CREDENTIALS_MESSAGE) {
            await loginThrottlesAsync.recordFailure(req.loginThrottleKey);
          }
          req.session.authError = info?.message || 'Invalid credentials.';
          return res.redirect('/login');
        }

        await loginThrottlesAsync.clear(req.loginThrottleKey);

        const returnTo = safeReturnTo(req);

        if (user.mfa_method && req.signedCookies?.mfa_remember) {
          const tokenHash = crypto.createHash('sha256').update(req.signedCookies.mfa_remember).digest('hex');
          const remembered = await mfaRememberTokensAsync.verify(user.id, tokenHash);
          if (remembered) {
            // A valid remember-token is itself a proven second factor from a
            // device that already passed MFA, so it bypasses an active lock by
            // design. Clear the lock: the holder has demonstrated possession,
            // and leaving it armed would strand their other browsers.
            await usersAsync.clearMfaFailures(user.id);
            return completeLogin(req, res, next, user, returnTo);
          }
        }

        // Refuse to mint a code while the account is locked. Without this the
        // lock is nearly useless: an attacker who has the password (which is
        // what it takes to get here) re-POSTs this route and gets a fresh live
        // OTP seconds after the old one was burned — and because the per-IP
        // limiter is the only cap on this route, a distributed attacker can
        // also pump unbounded verification email at the victim's mailbox.
        if (user.mfa_method === 'email' || user.mfa_method === 'totp') {
          const lockRemaining = await usersAsync.getMfaLockRemaining(user.id);
          if (lockRemaining > 0) {
            delete req.session.pendingLogin;
            req.session.authError = formatLockMessage(lockRemaining);
            return res.redirect('/login');
          }
        }

        if (user.mfa_method === 'email') {
          await beginEmailMfa(req, user, returnTo);
          return res.redirect('/login/mfa');
        }
        if (user.mfa_method === 'totp') {
          req.session.pendingLogin = { userId: user.id, returnTo, method: 'totp' };
          return res.redirect('/login/mfa');
        }
        return completeLogin(req, res, next, user, returnTo);
      }).catch((mfaErr) => {
        if (err) return next(mfaErr);
        req.session.authError = mfaErr.message || 'Could not send email verification code.';
        return res.redirect('/login');
      });
    })(req, res, next);
  }
);

router.get('/login/mfa', asyncHandler(async (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  const pending = req.session.pendingLogin;
  if (!pending?.userId) return res.redirect('/login');

  // A lock ends the sign-in attempt outright, here as on the POST paths — the
  // pending login is discarded rather than left dangling. Safe to be strict now
  // that POST /login refuses to start a new attempt while locked, so this
  // cannot bounce the user into a fresh OTP email.
  const lockRemaining = await usersAsync.getMfaLockRemaining(pending.userId);
  if (lockRemaining > 0) {
    delete req.session.pendingLogin;
    req.session.authError = formatLockMessage(lockRemaining);
    return res.redirect('/login');
  }

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
}));

router.post('/login/mfa', asyncHandler(async (req, res, next) => {
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

  // Lock state lives on the user row, so dropping the session cookie and
  // re-authenticating does not reset it.
  const lockRemaining = await usersAsync.getMfaLockRemaining(user.id);
  if (lockRemaining > 0) {
    delete req.session.pendingLogin;
    req.session.authError = formatLockMessage(lockRemaining);
    return res.redirect('/login');
  }

  if (pending.method === 'email') {
    valid = await usersAsync.verifyEmailOtp(user.id, code);
    if (valid) {
      await usersAsync.clearEmailOtp(user.id);
    }
  } else if (pending.method === 'totp') {
    valid = verifyTotp(await usersAsync.getTotpSecret(user.id), code);
  }

  if (!valid) {
    const { lockedUntil } = await usersAsync.recordMfaFailure(user.id);
    if (lockedUntil) {
      delete req.session.pendingLogin;
      req.session.authError = formatLockMessage(lockedUntil - Date.now());
      return res.redirect('/login');
    }
    req.session.authError = 'That verification code was not valid.';
    return res.redirect('/login/mfa');
  }

  await usersAsync.clearMfaFailures(user.id);

  // Set "remember this computer" cookie if requested (7-day lifetime)
  if (req.body.remember_device) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const MFA_REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + MFA_REMEMBER_MS).toISOString();
    await mfaRememberTokensAsync.create(user.id, tokenHash, expiresAt);
    res.cookie('mfa_remember', rawToken, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: requiresSecureTransport(),
      maxAge: MFA_REMEMBER_MS
    });
  }

  const returnTo = pending.returnTo || '/';
  delete req.session.pendingLogin;
  completeLogin(req, res, next, user, returnTo);
}));

router.post('/login/mfa/resend', asyncHandler(async (req, res) => {
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

  // Same reason as POST /login: a resend during a lock re-mints a live code
  // and sends another email.
  const lockRemaining = await usersAsync.getMfaLockRemaining(user.id);
  if (lockRemaining > 0) {
    delete req.session.pendingLogin;
    req.session.authError = formatLockMessage(lockRemaining);
    return res.redirect('/login');
  }

  try {
    await beginEmailMfa(req, user, pending.returnTo || '/');
  } catch (err) {
    req.session.authError = err.message || 'Could not resend the email verification code.';
  }
  res.redirect('/login/mfa');
}));

// ── Logout ─────────────────────────────────────────────────────────────────

router.post('/logout', asyncHandler(async (req, res, next) => {
  if (req.user && req.signedCookies?.mfa_remember) {
    const tokenHash = crypto.createHash('sha256').update(req.signedCookies.mfa_remember).digest('hex');
    await mfaRememberTokensAsync.deleteToken(req.user.id, tokenHash);
  }
  res.clearCookie('mfa_remember');
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
}));

// ── Register ───────────────────────────────────────────────────────────────

router.get('/register', asyncHandler(async (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  const bootstrap = await getBootstrapStatus();
  if (bootstrap.needsSetup) {
    req.session.authError = bootstrap.configured
      ? 'Initial administrator setup must be completed before public registration is available.'
      : 'Initial administrator setup is required. Set BOOTSTRAP_ADMIN_TOKEN and complete /setup first.';
    return res.redirect('/setup');
  }
  res.render('auth/register', {
    pageTitle: 'Create Account',
    error: consumeAuthError(req),
    bootstrap
  });
}));

router.get('/setup', asyncHandler(async (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  const bootstrap = await getBootstrapStatus();

  if (!bootstrap.needsSetup) {
    req.session.authError = 'Initial setup has already been completed. Please sign in.';
    return res.redirect('/login');
  }

  res.render('auth/setup', {
    pageTitle: 'Initial Setup',
    error: consumeAuthError(req),
    bootstrap
  });
}));

router.get('/terms', asyncHandler(async (req, res) => {
  const cfg = await settingsAsync.getAllPublic();
  const applicationSettings = resolveApplicationSettings(cfg);
  res.render('policy', {
    pageTitle: 'Terms of Service',
    title: 'Terms of Service',
    subtitle: 'The terms governing use of this site.',
    content: applicationSettings.termsOfService
  });
}));

router.get('/privacy', asyncHandler(async (req, res) => {
  const cfg = await settingsAsync.getAllPublic();
  const applicationSettings = resolveApplicationSettings(cfg);
  res.render('policy', {
    pageTitle: 'Privacy Policy',
    title: 'Privacy Policy',
    subtitle: 'How this application handles the information stored in it.',
    content: applicationSettings.privacyPolicy
  });
}));

router.get('/data-security', asyncHandler(async (req, res) => {
  const cfg = await settingsAsync.getAllPublic();
  const applicationSettings = resolveApplicationSettings(cfg);
  res.render('policy', {
    pageTitle: 'Data Security',
    title: 'Data Security',
    subtitle: 'How this application approaches access control and system protection.',
    content: applicationSettings.dataSecurityInfo
  });
}));

router.post('/setup', asyncHandler(async (req, res, next) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const email = (req.body.email || '').trim().toLowerCase() || null;
  const password = req.body.password || '';
  const confirm = req.body.confirm || '';
  const bootstrapToken = req.body.bootstrap_token || '';
  const configuredToken = getBootstrapToken();

  const bootstrap = await getBootstrapStatus();
  if (!bootstrap.needsSetup) {
    req.session.authError = 'Initial setup has already been completed. Please sign in.';
    return res.redirect('/login');
  }
  if (!configuredToken) {
    req.session.authError = 'BOOTSTRAP_ADMIN_TOKEN is not configured. Set it in the environment before using /setup.';
    return res.redirect('/setup');
  }

  if (!username || !password) {
    req.session.authError = 'Username and password are required.';
    return res.redirect('/setup');
  }
  if (username.length < 3 || !/^[a-z0-9_.-]+$/.test(username)) {
    req.session.authError = 'Username must be at least 3 characters and contain only letters, numbers, _ . -';
    return res.redirect('/setup');
  }
  if (password.length < 8) {
    req.session.authError = 'Password must be at least 8 characters.';
    return res.redirect('/setup');
  }
  if (password !== confirm) {
    req.session.authError = 'Passwords do not match.';
    return res.redirect('/setup');
  }
  if (!constantTimeMatches(bootstrapToken, configuredToken)) {
    req.session.authError = 'The setup token is not valid.';
    return res.redirect('/setup');
  }
  if (await usersAsync.findByUsername(username)) {
    req.session.authError = 'That username is already taken.';
    return res.redirect('/setup');
  }
  if (email && await usersAsync.findByEmail(email)) {
    req.session.authError = 'That email address is already associated with an account.';
    return res.redirect('/setup');
  }

  const passwordHash = await hashPassword(password);
  let id;
  try {
    id = await usersAsync.create({
      username,
      email,
      passwordHash,
      role: 'admin',
      status: 'active',
      accessAll: true,
      canUseSystemApiKeys: true
    });
  } catch (err) {
    if ((err.message || '').includes('users.email')) {
      req.session.authError = 'That email address is already associated with an account.';
      return res.redirect('/setup');
    }
    return next(err);
  }

  req.session.authError = 'Initial administrator created. Please sign in.';
  res.redirect('/login');
}));

router.post('/register', asyncHandler(async (req, res, next) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const email    = (req.body.email    || '').trim().toLowerCase() || null;
  const password =  req.body.password || '';
  const confirm  =  req.body.confirm  || '';
  const bootstrap = await getBootstrapStatus();

  if (bootstrap.needsSetup) {
    req.session.authError = bootstrap.configured
      ? 'Initial administrator setup must be completed before public registration is available.'
      : 'Initial administrator setup is required. Set BOOTSTRAP_ADMIN_TOKEN and complete /setup first.';
    return res.redirect('/setup');
  }

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
  // Registration is public, so it must not confirm which usernames or emails
  // already have accounts. A collision gets the same redirect as a new request
  // and creates nothing; the pending page explains that case. The hash is
  // computed first so both outcomes also cost the same.
  const passwordHash = await hashPassword(password);
  if (await usersAsync.findByUsername(username) || (email && await usersAsync.findByEmail(email))) {
    return res.redirect('/pending');
  }

  try {
    await usersAsync.create({
      username,
      email,
      passwordHash,
      role: 'user',
      status: 'pending',
      accessAll: false,
      canUseSystemApiKeys: false
    });
  } catch (err) {
    // Lost a race with a concurrent registration for the same name or email.
    if (/users\.(email|username)/.test(err.message || '')) {
      return res.redirect('/pending');
    }
    return next(err);
  }

  // Show pending page — do not auto-login
  return res.redirect('/pending');
}));

// ── Pending approval ───────────────────────────────────────────────────────

router.get('/pending', (req, res) => {
  // If somehow an active user lands here, redirect home
  if (req.isAuthenticated() && req.user.status === 'active') {
    return res.redirect('/');
  }
  res.render('auth/pending', { pageTitle: 'Account Pending' });
});

router.get('/invite/:token', asyncHandler(async (req, res) => {
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
}));

router.post('/invite/:token', asyncHandler(async (req, res, next) => {
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

  const passwordHash = await hashPassword(password);
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

  req.session.authError = 'Account created. Please sign in.';
  res.redirect('/login');
}));

router.get('/reset-password/:token', asyncHandler(async (req, res) => {
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
}));

router.post('/reset-password/:token', asyncHandler(async (req, res) => {
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

  const passwordHash = await hashPassword(password);
  await usersAsync.updatePassword(reset.user_id, passwordHash);
  await usersAsync.updatePasswordChangedAt(reset.user_id);
  // Clear any MFA lock too. A user who fluffed their code, assumed the password
  // was wrong and reset it would otherwise still be locked out afterwards, with
  // nothing connecting the two.
  await usersAsync.clearMfaFailures(reset.user_id);
  // Likewise the sign-in throttle: wrong guesses are usually why they reset.
  await loginThrottlesAsync.clear(loginThrottlesAsync.keyForUsername(reset.username));
  await revokeRememberedDevicesForUser(res, reset.user_id);
  await passwordResetTokensAsync.markUsed(reset.id);
  await passwordResetTokensAsync.revokeForUser(reset.user_id);

  req.session.authError = 'Your password has been reset. Please sign in.';
  res.redirect('/login');
}));

module.exports = router;
