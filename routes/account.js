'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { canEncryptSecrets } = require('../utils/secrets');
const { isSmtpConfigured } = require('../utils/email');
const {
  userApiKeysAsync,
  usersAsync,
  settingsAsync,
  mfaRememberTokensAsync
} = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');
const {
  buildOtpAuthUrl,
  generateTotpSecret,
  verifyTotp
} = require('../utils/mfa');
const { resolveApplicationSettings } = require('../utils/application-settings');

router.use(requireAuth);

function normalizeProvider(provider) {
  return ['openai', 'claude', 'gemini'].includes(provider) ? provider : null;
}

async function revokeRememberedDevices(req) {
  await mfaRememberTokensAsync.deleteForUser(req.user.id);
  req.res.clearCookie('mfa_remember');
}

router.get('/', asyncHandler(async (req, res) => {
  const cfg = await settingsAsync.getAllPublic();
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
    ? await require('qrcode').toDataURL(pendingTotpUri, {
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
}));

const MFA_EMAIL_REQUIRED_ERROR = 'Turn off email MFA before removing your email address.';

router.post('/profile', asyncHandler(async (req, res) => {
  // Not every body shape gives a string: `?email[]=a&email[]=b` yields an array
  // under express.urlencoded, and a JSON body can carry any type. Coerce before
  // trimming so a malformed submission is a redirect, not a 500.
  const raw = req.body.email;
  const email = (typeof raw === 'string' ? raw : '').trim().toLowerCase() || null;

  // Mirror of the guard on /mfa/email/enable below. Email MFA sends the OTP to
  // users.email, so clearing the address while that method is active locks the
  // account out permanently — see docs/development-principles.md § Guards must
  // be symmetric. Checked here for the message; enforced atomically in
  // usersAsync.updateEmail, which is what actually closes the race.
  if (!email && req.user.mfa_method === 'email') {
    return res.redirect('/account?error=' + encodeURIComponent(MFA_EMAIL_REQUIRED_ERROR));
  }

  const existing = email ? await usersAsync.findByEmail(email) : null;
  if (existing && existing.id !== req.user.id) {
    return res.redirect('/account?error=' + encodeURIComponent('That email address is already in use.'));
  }

  if (!(await usersAsync.updateEmail(req.user.id, email))) {
    // The conditional write refused: email MFA was switched on concurrently.
    return res.redirect('/account?error=' + encodeURIComponent(MFA_EMAIL_REQUIRED_ERROR));
  }
  res.redirect('/account?saved=1');
}));

router.post('/api-keys', asyncHandler(async (req, res) => {
  if (!canEncryptSecrets()) {
    return res.redirect('/account?error=' + encodeURIComponent('DATA_ENCRYPTION_KEY must be configured before saving personal API keys.'));
  }

  const provider = normalizeProvider(req.body.provider);
  const label = (req.body.label || '').trim();
  const apiKey = (req.body.api_key || '').trim();
  const modelRaw = (req.body.model || '').trim() || null;
  const visionModelRaw = (req.body.vision_model || '').trim() || null;
  const utilityModelRaw = (req.body.utility_model || '').trim() || null;
  const inputCostRaw = (req.body.input_cost_per_mtok || '').trim();
  const outputCostRaw = (req.body.output_cost_per_mtok || '').trim();
  const utilityInputCostRaw = (req.body.utility_input_cost_per_mtok || '').trim();
  const utilityOutputCostRaw = (req.body.utility_output_cost_per_mtok || '').trim();

  // Validate model name format (alphanumeric, hyphens, dots, colons, slashes; max 100 chars)
  const MODEL_NAME_RE = /^[a-zA-Z0-9._:/-]{1,100}$/;
  const model = modelRaw && MODEL_NAME_RE.test(modelRaw) ? modelRaw : null;
  const visionModel = visionModelRaw && MODEL_NAME_RE.test(visionModelRaw) ? visionModelRaw : null;
  const utilityModel = utilityModelRaw && MODEL_NAME_RE.test(utilityModelRaw) ? utilityModelRaw : null;

  const inputCostPerMtok = inputCostRaw !== '' ? parseFloat(inputCostRaw) : null;
  const outputCostPerMtok = outputCostRaw !== '' ? parseFloat(outputCostRaw) : null;
  const utilityInputCostPerMtok = utilityInputCostRaw !== '' ? parseFloat(utilityInputCostRaw) : null;
  const utilityOutputCostPerMtok = utilityOutputCostRaw !== '' ? parseFloat(utilityOutputCostRaw) : null;
  const allRates = [inputCostPerMtok, outputCostPerMtok, utilityInputCostPerMtok, utilityOutputCostPerMtok];
  if (allRates.some(r => r != null && (isNaN(r) || r < 0))) {
    return res.redirect('/account?error=' + encodeURIComponent('Cost rates must be non-negative numbers.'));
  }

  if (!provider || !label || !apiKey) {
    return res.redirect('/account?error=' + encodeURIComponent('Provider, label, and API key are required.'));
  }

  await userApiKeysAsync.create({
    userId: req.user.id,
    provider,
    label,
    apiKey,
    model,
    visionModel,
    utilityModel,
    inputCostPerMtok,
    outputCostPerMtok,
    utilityInputCostPerMtok,
    utilityOutputCostPerMtok
  });
  res.redirect('/account?saved=1');
}));

router.post('/api-keys/:id/delete', asyncHandler(async (req, res) => {
  await userApiKeysAsync.delete(parseInt(req.params.id, 10), req.user.id);
  res.redirect('/account?saved=1');
}));

router.post('/mfa/disable', asyncHandler(async (req, res) => {
  await usersAsync.setMfaMethod(req.user.id, 'none');
  await usersAsync.setTotpSecret(req.user.id, null);
  await usersAsync.clearEmailOtp(req.user.id);
  await revokeRememberedDevices(req);
  delete req.session.pendingTotpSecret;
  res.redirect('/account?saved=1');
}));

router.post('/mfa/email/enable', asyncHandler(async (req, res) => {
  if (!req.user.email) {
    return res.redirect('/account?error=' + encodeURIComponent('Add an email address before enabling email MFA.'));
  }
  if (!isSmtpConfigured()) {
    return res.redirect('/account?error=' + encodeURIComponent('SMTP is not configured yet, so email MFA is unavailable.'));
  }

  // The conditional write is the authority; the check above is for the
  // message. It refuses if the address was cleared concurrently.
  if (!(await usersAsync.setMfaMethod(req.user.id, 'email'))) {
    return res.redirect('/account?error=' + encodeURIComponent('Add an email address before enabling email MFA.'));
  }
  res.redirect('/account?saved=1');
}));

router.post('/mfa/totp/setup', (req, res) => {
  if (!canEncryptSecrets()) {
    return res.redirect('/account?error=' + encodeURIComponent('DATA_ENCRYPTION_KEY must be configured before enabling authenticator-app MFA.'));
  }

  req.session.pendingTotpSecret = generateTotpSecret();
  res.redirect('/account');
});

router.post('/mfa/totp/confirm', asyncHandler(async (req, res) => {
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
  await revokeRememberedDevices(req);
  delete req.session.pendingTotpSecret;
  res.redirect('/account?saved=1');
}));

router.post('/mfa/totp/cancel', (req, res) => {
  delete req.session.pendingTotpSecret;
  res.redirect('/account');
});

module.exports = router;
