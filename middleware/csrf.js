'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_SECRET_BYTES = 32;

// ── Why the emitted token is masked ─────────────────────────────────────────
// The session holds one long-lived secret, but a *stable* secret rendered into
// a compressed HTML response is the BREACH precondition: the page shell also
// reflects attacker-controlled input (the `?q=` search box in
// views/partials/header.ejs), so an attacker who can observe encrypted
// response sizes and induce many same-site requests could recover the token
// byte by byte from compression-ratio differences.
//
// So the secret never leaves the server. Each render emits
// `<mask>.<secret XOR mask>` with a fresh random mask, which is a different
// byte string every response — there is no longer a stable string for a guess
// to correlate against, and compression cannot leak it. `validateCsrf`
// re-derives the secret from the submitted pair and compares in constant time.
// This is the same defence Rails and Django apply, for the same reason.
//
// Consumers treat the value as opaque (a hidden `_csrf` field, or the
// `<meta name="csrf-token">` read by page JS for the `X-CSRF-Token` header),
// so nothing outside this file needs to know the shape.

function isHex(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** Wraps the session secret in a fresh random mask for one response. */
function maskCsrfToken(secretHex) {
  const secret = Buffer.from(secretHex, 'hex');
  const mask = crypto.randomBytes(secret.length);
  return `${mask.toString('hex')}.${xorBuffers(secret, mask).toString('hex')}`;
}

/**
 * Recovers the secret from a masked token. Returns null on any malformed
 * input — the token's *shape* is not secret, so rejecting early here leaks
 * nothing; the comparison against the real secret is what must be constant
 * time.
 */
function unmaskCsrfToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [maskHex, maskedHex] = parts;
  if (!isHex(maskHex) || !isHex(maskedHex)) return null;
  if (maskHex.length !== maskedHex.length) return null;
  const mask = Buffer.from(maskHex, 'hex');
  const masked = Buffer.from(maskedHex, 'hex');
  if (mask.length !== masked.length) return null;
  return xorBuffers(mask, masked).toString('hex');
}

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(CSRF_SECRET_BYTES).toString('hex');
  }
  res.locals.csrfToken = maskCsrfToken(req.session.csrfToken);
  next();
}

function matchesSecret(candidateHex, secretHex) {
  if (!candidateHex) return false;
  const candidate = Buffer.from(candidateHex);
  const secret = Buffer.from(secretHex);
  return candidate.length === secret.length && crypto.timingSafeEqual(candidate, secret);
}

function validateCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const contentType = req.headers['content-type'] || '';
  if (contentType.startsWith('multipart/form-data') && !req._csrfValidated) {
    if (!req._csrfDeferred) {
      req._csrfDeferred = true;
      return next();
    }
    req._csrfDeferred = false;
  }

  const token = req.body?._csrf || req.headers['x-csrf-token'];
  const secret = req.session.csrfToken;
  let valid = false;
  if (token && secret) {
    const unmasked = unmaskCsrfToken(token);
    // The bare-secret form is accepted as well, so a form rendered before a
    // deploy still submits successfully afterwards. It is no weaker: masking
    // exists to keep the secret out of the *response*, and accepting it on the
    // way in reveals nothing.
    valid = unmasked
      ? matchesSecret(unmasked, secret)
      : matchesSecret(String(token), secret);
  }

  if (!valid) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    }
    req.session.authError = 'Your session expired. Please try again.';
    return res.redirect('/');
  }

  req._csrfValidated = true;
  next();
}

module.exports = {
  ensureCsrfToken,
  validateCsrf,
  maskCsrfToken,
  unmaskCsrfToken
};
