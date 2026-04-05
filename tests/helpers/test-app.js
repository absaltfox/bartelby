'use strict';

/**
 * Initialises the Express app for integration tests.
 *
 * - Uses an in-memory sql.js database (no file I/O).
 * - Disables the background worker.
 * - Sets a deterministic session secret.
 * - Returns the fully-initialised app ready for supertest.
 */

// Must be set before server.js is required
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

let initialised = false;
let appInstance = null;

async function getApp() {
  if (initialised) return appInstance;

  // Reset module registry so each test suite gets a fresh DB state
  const { app, initApp } = require('../../server');
  await initApp();
  appInstance = app;
  initialised = true;
  return app;
}

/** Reset between test suites if needed */
function resetApp() {
  initialised = false;
  appInstance = null;
  jest.resetModules();
}

module.exports = { getApp, resetApp };
