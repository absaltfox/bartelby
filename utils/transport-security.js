'use strict';

// Single owner of "must this instance be reached over TLS?". Production
// assumes yes: session and remember-device cookies are marked Secure, and the
// response headers tell browsers to upgrade to https. A single-machine
// evaluation install (docker-compose.yml) is served over plain http on
// localhost, where a Secure cookie is never sent and sign-in cannot stick, so
// it opts out explicitly with ALLOW_INSECURE_HTTP_IN_PRODUCTION=1.
// validateProductionConfiguration() in server.js refuses that override when
// PUBLIC_APP_URL is https and logs a warning whenever it is in effect.

const OVERRIDE_ENV = 'ALLOW_INSECURE_HTTP_IN_PRODUCTION';

function isProduction(env) {
  return String(env.NODE_ENV || '').trim() === 'production';
}

function allowsInsecureHttp(env = process.env) {
  return isProduction(env) && /^(1|true|yes|on)$/i.test(String(env[OVERRIDE_ENV] || ''));
}

function requiresSecureTransport(env = process.env) {
  return isProduction(env) && !allowsInsecureHttp(env);
}

module.exports = { OVERRIDE_ENV, allowsInsecureHttp, requiresSecureTransport };
