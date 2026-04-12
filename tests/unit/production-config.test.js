'use strict';

describe('production configuration validation', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadServerWithEnv(env) {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-test-secret',
      DISABLE_BACKGROUND_WORKER: '1',
      DATABASE_DRIVER: 'sqljs',
      ...env
    };

    const warn = jest.fn(() => Promise.resolve());
    jest.doMock('../../utils/logger', () => ({
      warn,
      info: jest.fn(() => Promise.resolve()),
      error: jest.fn(() => Promise.resolve()),
      fatal: jest.fn(() => Promise.resolve()),
      requestLoggingMiddleware: () => (req, res, next) => next(),
      startEventLoopMonitor: jest.fn(),
      startLogMaintenance: jest.fn(),
      stopBackgroundTasks: jest.fn()
    }));

    const server = require('../../server');
    return { server, warn };
  }

  it('rejects in-memory sessions in production unless explicitly overridden', () => {
    const { server } = loadServerWithEnv({
      SESSION_STORE: 'memory',
      STORAGE_DRIVER: 's3'
    });

    expect(() => server.validateProductionConfiguration()).toThrow(
      'SESSION_STORE=memory is not allowed in production'
    );
  });

  it('rejects local upload storage in production unless explicitly overridden', () => {
    const { server } = loadServerWithEnv({
      SESSION_STORE: 'redis',
      STORAGE_DRIVER: 'local'
    });

    expect(() => server.validateProductionConfiguration()).toThrow(
      'STORAGE_DRIVER=local is not allowed in production'
    );
  });

  it('allows explicit production overrides and logs warnings for them', () => {
    const { server, warn } = loadServerWithEnv({
      SESSION_STORE: 'memory',
      STORAGE_DRIVER: 'local',
      ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION: '1',
      ALLOW_LOCAL_STORAGE_IN_PRODUCTION: '1'
    });

    expect(() => server.validateProductionConfiguration()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
