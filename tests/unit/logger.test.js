'use strict';

jest.mock('../../database/db', () => ({
  settingsAsync: {
    getMany: jest.fn(async () => ({
      log_level: 'info',
      log_persist_enabled: '0',
      log_persist_min_level: 'warn',
      log_slow_request_ms: '1000',
      log_event_loop_monitor_enabled: '0',
      log_event_loop_lag_warn_ms: '250',
      log_retention_days: '14'
    }))
  }
}));

describe('logger utilities', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('normalizes levels and falls back safely', async () => {
    const logger = require('../../utils/logger');
    expect(logger.normalizeLevel('WARN')).toBe('warn');
    expect(logger.normalizeLevel('nope')).toBe('info');
  });

  it('redacts sensitive fields from context', async () => {
    const logger = require('../../utils/logger');
    const safe = logger.sanitizeContext({
      apiKey: 'secret-key',
      nested: {
        password: 'hunter2',
        ok: 'value'
      },
      promptTemplate: 'should not leak',
      collectionId: 7
    });

    expect(safe.apiKey).toBe('[redacted]');
    expect(safe.nested.password).toBe('[redacted]');
    expect(safe.nested.ok).toBe('value');
    expect(safe.promptTemplate).toBe('[redacted]');
    expect(safe.collectionId).toBe(7);
  });
});
