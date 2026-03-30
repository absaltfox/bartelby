'use strict';

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { requireAuth } = require('../middleware/auth');
const { canEncryptSecrets } = require('../utils/secrets');
const { isSmtpConfigured } = require('../utils/email');
const { userApiKeysAsync, usersAsync, settingsAsync } = require('../database/db');
const {
  buildOtpAuthUrl,
  generateTotpSecret,
  verifyTotp
} = require('../utils/mfa');
const { resolveApplicationSettings } = require('../utils/application-settings');

router.use(requireAuth);

function normalizeProvider(provider) {
  return ['openai', 'claude'].includes(provider) ? provider : null;
}

router.get('/', async (req, res) => {
  const cfg = await settingsAsync.getAll();
  const applicationSettings = resolveApplicationSettings(cfg);
  const pendingTotpSecret = req.session.pendingTotpSecret || null;
  const pendingTotpUri = pendingTotpSecret
    ? buildOtpAuthUrl({
        accountName: req.user.email || req.user.username,
        issuer: applicationSettings.appName,
        secret: pendingTotpSecret
      })
    : null;
  const pendingTotpQrCode = pendingTotpUri
    ? await QRCode.toDataURL(pendingTotpUri, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 220
      })
    : null;

  res.render('account', {
    pageTitle: 'My Account',
    saved: req.query.saved === '1',
    error: req.query.error || null,
    userApiKeys: await userApiKeysAsync.getByUserId(req.user.id),
    canEncryptSecrets: canEncryptSecrets(),
    smtpConfigured: isSmtpConfigured(),
    pendingTotpSecret,
    pendingTotpUri,
    pendingTotpQrCode
  });
});

router.post('/profile', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase() || null;
  const existing = email ? await usersAsync.findByEmail(email) : null;
  if (existing && existing.id !== req.user.id) {
    return res.redirect('/account?error=' + encodeURIComponent('That email address is already in use.'));
  }

  await usersAsync.updateEmail(req.user.id, email);
  res.redirect('/account?saved=1');
});

router.post('/api-keys', async (req, res) => {
  if (!canEncryptSecrets()) {
    return res.redirect('/account?error=' + encodeURIComponent('DATA_ENCRYPTION_KEY must be configured before saving personal API keys.'));
  }

  const provider = normalizeProvider(req.body.provider);
  const label = (req.body.label || '').trim();
  const apiKey = (req.body.api_key || '').trim();
  const model = (req.body.model || '').trim() || null;
  const visionModel = (req.body.vision_model || '').trim() || null;

  if (!provider || !label || !apiKey) {
    return res.redirect('/account?error=' + encodeURIComponent('Provider, label, and API key are required.'));
  }

  await userApiKeysAsync.create({
    userId: req.user.id,
    provider,
    label,
    apiKey,
    model,
    visionModel
  });
  res.redirect('/account?saved=1');
});

router.post('/api-keys/:id/delete', async (req, res) => {
  await userApiKeysAsync.delete(parseInt(req.params.id, 10), req.user.id);
  res.redirect('/account?saved=1');
});

router.post('/mfa/disable', async (req, res) => {
  await usersAsync.setMfaMethod(req.user.id, 'none');
  await usersAsync.setTotpSecret(req.user.id, null);
  await usersAsync.clearEmailOtp(req.user.id);
  delete req.session.pendingTotpSecret;
  res.redirect('/account?saved=1');
});

router.post('/mfa/email/enable', async (req, res) => {
  if (!req.user.email) {
    return res.redirect('/account?error=' + encodeURIComponent('Add an email address before enabling email MFA.'));
  }
  if (!isSmtpConfigured()) {
    return res.redirect('/account?error=' + encodeURIComponent('SMTP is not configured yet, so email MFA is unavailable.'));
  }

  await usersAsync.setMfaMethod(req.user.id, 'email');
  res.redirect('/account?saved=1');
});

router.post('/mfa/totp/setup', (req, res) => {
  if (!canEncryptSecrets()) {
    return res.redirect('/account?error=' + encodeURIComponent('DATA_ENCRYPTION_KEY must be configured before enabling authenticator-app MFA.'));
  }

  req.session.pendingTotpSecret = generateTotpSecret();
  res.redirect('/account');
});

router.post('/mfa/totp/confirm', async (req, res) => {
  const secret = req.session.pendingTotpSecret;
  const code = (req.body.code || '').trim();

  if (!secret) {
    return res.redirect('/account?error=' + encodeURIComponent('Start authenticator setup before confirming a code.'));
  }
  if (!verifyTotp(secret, code)) {
    return res.redirect('/account?error=' + encodeURIComponent('That authenticator code was not valid.'));
  }

  await usersAsync.setTotpSecret(req.user.id, secret);
  await usersAsync.setMfaMethod(req.user.id, 'totp');
  await usersAsync.clearEmailOtp(req.user.id);
  delete req.session.pendingTotpSecret;
  res.redirect('/account?saved=1');
});

router.post('/mfa/totp/cancel', (req, res) => {
  delete req.session.pendingTotpSecret;
  res.redirect('/account');
});

module.exports = router;
