'use strict';

describe('runtime topology configuration', () => {
  const originalDisableWorker = process.env.DISABLE_BACKGROUND_WORKER;
  const originalFlyProcessGroup = process.env.FLY_PROCESS_GROUP;
  const originalTursoKeepAlive = process.env.TURSO_HTTP_KEEP_ALIVE;

  afterEach(() => {
    jest.resetModules();
    if (originalDisableWorker == null) {
      delete process.env.DISABLE_BACKGROUND_WORKER;
    } else {
      process.env.DISABLE_BACKGROUND_WORKER = originalDisableWorker;
    }

    if (originalFlyProcessGroup == null) {
      delete process.env.FLY_PROCESS_GROUP;
    } else {
      process.env.FLY_PROCESS_GROUP = originalFlyProcessGroup;
    }

    if (originalTursoKeepAlive == null) {
      delete process.env.TURSO_HTTP_KEEP_ALIVE;
    } else {
      process.env.TURSO_HTTP_KEEP_ALIVE = originalTursoKeepAlive;
    }
  });

  it('enables the background worker by default', () => {
    delete process.env.DISABLE_BACKGROUND_WORKER;
    delete process.env.FLY_PROCESS_GROUP;
    const config = require('../../config');
    expect(config.runtime.startWorker).toBe(true);
  });

  it('disables the background worker when DISABLE_BACKGROUND_WORKER=1', () => {
    process.env.DISABLE_BACKGROUND_WORKER = '1';
    delete process.env.FLY_PROCESS_GROUP;
    const config = require('../../config');
    expect(config.runtime.startWorker).toBe(false);
  });

  it('disables the background worker for Fly web process groups', () => {
    delete process.env.DISABLE_BACKGROUND_WORKER;
    process.env.FLY_PROCESS_GROUP = 'web';
    const config = require('../../config');
    expect(config.runtime.startWorker).toBe(false);
  });

  it('turns off Turso connection reuse in processes that run the worker', () => {
    delete process.env.DISABLE_BACKGROUND_WORKER;
    delete process.env.TURSO_HTTP_KEEP_ALIVE;
    process.env.FLY_PROCESS_GROUP = 'worker';
    const config = require('../../config');
    expect(config.database.turso.keepAlive).toBe(false);
  });

  it('keeps Turso connection reuse on for Fly web process groups', () => {
    delete process.env.DISABLE_BACKGROUND_WORKER;
    delete process.env.TURSO_HTTP_KEEP_ALIVE;
    process.env.FLY_PROCESS_GROUP = 'web';
    const config = require('../../config');
    expect(config.database.turso.keepAlive).toBe(true);
  });

  it('lets TURSO_HTTP_KEEP_ALIVE override the default either way', () => {
    delete process.env.DISABLE_BACKGROUND_WORKER;
    process.env.FLY_PROCESS_GROUP = 'worker';
    process.env.TURSO_HTTP_KEEP_ALIVE = 'true';
    expect(require('../../config').database.turso.keepAlive).toBe(true);
    jest.resetModules();
    process.env.FLY_PROCESS_GROUP = 'web';
    process.env.TURSO_HTTP_KEEP_ALIVE = 'false';
    expect(require('../../config').database.turso.keepAlive).toBe(false);
  });
});
