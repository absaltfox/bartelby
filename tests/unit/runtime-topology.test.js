'use strict';

describe('runtime topology configuration', () => {
  const originalDisableWorker = process.env.DISABLE_BACKGROUND_WORKER;
  const originalFlyProcessGroup = process.env.FLY_PROCESS_GROUP;

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
});
