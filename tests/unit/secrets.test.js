'use strict';

/**
 * Tests for the DATA_ENCRYPTION_KEY entropy check in utils/secrets.js.
 * Each test resets the module registry and sets the env var independently.
 */

afterEach(() => {
  delete process.env.DATA_ENCRYPTION_KEY;
  jest.resetModules();
});

function loadGetEncryptionKey() {
  // Fresh require after jest.resetModules() so envLoaded is reset
  return require('../../utils/secrets').getEncryptionKey;
}

describe('getEncryptionKey — entropy enforcement', () => {
  it('returns null when DATA_ENCRYPTION_KEY is not set', () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    jest.resetModules();
    expect(loadGetEncryptionKey()()).toBeNull();
  });

  it('throws for a key shorter than 32 characters', () => {
    process.env.DATA_ENCRYPTION_KEY = 'tooshort';
    jest.resetModules();
    expect(() => loadGetEncryptionKey()()).toThrow(/too short/i);
  });

  it('throws for a 31-character key (off-by-one boundary)', () => {
    process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(31);
    jest.resetModules();
    expect(() => loadGetEncryptionKey()()).toThrow(/too short/i);
  });

  it('returns a 32-byte Buffer for a 32-character key (minimum valid)', () => {
    process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(32);
    jest.resetModules();
    const key = loadGetEncryptionKey()();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32); // SHA-256 always produces 32 bytes
  });

  it('returns a Buffer for a long, strong key', () => {
    process.env.DATA_ENCRYPTION_KEY = 'f3a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3';
    jest.resetModules();
    expect(Buffer.isBuffer(loadGetEncryptionKey()())).toBe(true);
  });
});
