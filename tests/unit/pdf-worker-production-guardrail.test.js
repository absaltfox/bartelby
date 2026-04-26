'use strict';

describe('pdf-worker production guardrail', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    jest.resetModules();
  });

  it('throws at module-init when production lacks pdftoppm', () => {
    process.env.NODE_ENV = 'production';

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => { throw new Error('command not found: pdftoppm'); }),
      spawn: jest.fn(),
      execSync: jest.fn()
    }));

    expect(() => require('../../utils/pdf-worker'))
      .toThrow(/pdftoppm/);
  });

  it('does not throw in development when pdftoppm is missing', () => {
    process.env.NODE_ENV = 'development';

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => { throw new Error('command not found: pdftoppm'); }),
      spawn: jest.fn(),
      execSync: jest.fn()
    }));

    expect(() => require('../../utils/pdf-worker')).not.toThrow();
  });
});
