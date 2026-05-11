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
      PUBLIC_APP_URL: 'https://bartelby.example.com',
      TRUST_PROXY: '1',
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

  it('requires PUBLIC_APP_URL in production', () => {
    const { server } = loadServerWithEnv({
      PUBLIC_APP_URL: '',
      SESSION_STORE: 'redis',
      STORAGE_DRIVER: 's3'
    });

    expect(() => server.validateProductionConfiguration()).toThrow(
      'PUBLIC_APP_URL must be configured in production'
    );
  });

  it('redirects direct-origin hosts to the canonical PUBLIC_APP_URL in production', () => {
    const { server } = loadServerWithEnv({
      SESSION_STORE: 'memory',
      STORAGE_DRIVER: 's3'
    });
    const req = {
      path: '/collections/2',
      originalUrl: '/collections/2?type=letter',
      headers: { host: 'bartelby.fly.dev' }
    };
    const res = { redirect: jest.fn() };
    const next = jest.fn();

    server.canonicalHostGuard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      308,
      'https://bartelby.example.com/collections/2?type=letter'
    );
  });

  it('allows the canonical host and explicit extra hosts in production', () => {
    const { server } = loadServerWithEnv({
      SESSION_STORE: 'memory',
      STORAGE_DRIVER: 's3',
      PUBLIC_ALLOWED_HOSTS: 'www.bartelby.example.com'
    });
    const next = jest.fn();

    server.canonicalHostGuard({
      path: '/collections',
      originalUrl: '/collections',
      headers: { host: 'www.bartelby.example.com' }
    }, { redirect: jest.fn() }, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('always allows health checks through the host guard', () => {
    const { server } = loadServerWithEnv({
      SESSION_STORE: 'memory',
      STORAGE_DRIVER: 's3'
    });
    const next = jest.fn();

    server.canonicalHostGuard({
      path: '/healthz',
      originalUrl: '/healthz',
      headers: { host: 'bartelby.fly.dev' }
    }, { redirect: jest.fn() }, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('validateProductionConfiguration', () => {
  let validateProductionConfiguration;

  beforeEach(() => {
    jest.resetModules();
    // Minimal production env
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    process.env.SESSION_STORE = 'memory';
    process.env.ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION = '1';
    process.env.STORAGE_DRIVER = 'local';
    process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION = '1';
    delete process.env.TRUST_PROXY;
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.TRUST_PROXY;
    delete process.env.PUBLIC_APP_URL;
    delete process.env.SESSION_SECRET;
    delete process.env.SESSION_STORE;
    delete process.env.STORAGE_DRIVER;
    delete process.env.ALLOW_MEMORY_SESSION_STORE_IN_PRODUCTION;
    delete process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION;
  });

  function load() {
    // Stub out the database and logger so the module loads without side effects.
    jest.doMock('../../database/db', () => ({}));
    jest.doMock('../../utils/logger', () => ({
      warn: jest.fn().mockResolvedValue(undefined),
      info: jest.fn().mockResolvedValue(undefined),
      error: jest.fn().mockResolvedValue(undefined),
      fatal: jest.fn().mockResolvedValue(undefined),
      requestLoggingMiddleware: () => (req, res, next) => next(),
      startEventLoopMonitor: jest.fn(),
      startLogMaintenance: jest.fn(),
      stopBackgroundTasks: jest.fn()
    }));
    return require('../../server').validateProductionConfiguration;
  }

  it('throws when TRUST_PROXY is not set in production', () => {
    validateProductionConfiguration = load();
    expect(() => validateProductionConfiguration()).toThrow(/TRUST_PROXY/);
  });

  it('throws when TRUST_PROXY is "0" in production', () => {
    process.env.TRUST_PROXY = '0';
    validateProductionConfiguration = load();
    expect(() => validateProductionConfiguration()).toThrow(/TRUST_PROXY/);
  });

  it('does not throw when TRUST_PROXY is "1" in production', () => {
    process.env.TRUST_PROXY = '1';
    validateProductionConfiguration = load();
    expect(() => validateProductionConfiguration()).not.toThrow();
  });
});
