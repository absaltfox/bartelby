'use strict';

const config = require('../config');

function getPublicAppUrl(req) {
  const configured = String(config.app.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (configured) return configured;

  if (config.runtime.nodeEnv === 'production') {
    throw new Error('PUBLIC_APP_URL must be configured in production.');
  }

  if (!req) return 'http://localhost:3000';
  return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

function absoluteAppUrl(req, pathname) {
  const base = getPublicAppUrl(req);
  const path = String(pathname || '/');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = {
  getPublicAppUrl,
  absoluteAppUrl
};
