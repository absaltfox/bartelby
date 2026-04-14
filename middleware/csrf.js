'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
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
  const valid = token && req.session.csrfToken &&
    (() => {
      const tokenBuf = Buffer.from(String(token));
      const expectedBuf = Buffer.from(req.session.csrfToken);
      return tokenBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(tokenBuf, expectedBuf);
    })();

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
  validateCsrf
};
