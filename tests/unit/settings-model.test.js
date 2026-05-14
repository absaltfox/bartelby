'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('settings model — set() trims string values', () => {
  let db;
  let settingsAsync;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-model-'));
    process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db')}`;
    process.env.STORAGE_DRIVER = 'local';
    // Required for SECRET_SETTING_KEYS round-trip (api keys etc.)
    process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY
      || 'test-encryption-key-must-be-at-least-32-chars-long-ok';
    jest.resetModules();
    db = require('../../database/db');
    await db.initializeSchema({ runStaleJobRecovery: false });
    settingsAsync = db.settingsAsync;
  });

  afterEach(async () => {
    if (db && db.closeAsync) await db.closeAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('trims leading whitespace', async () => {
    await settingsAsync.set('vertex_batch_bucket', '  bartelby-vt-trans');
    expect(await settingsAsync.get('vertex_batch_bucket')).toBe('bartelby-vt-trans');
  });

  test('trims trailing whitespace including newlines', async () => {
    await settingsAsync.set('default_provider', 'vertex\n');
    expect(await settingsAsync.get('default_provider')).toBe('vertex');
  });

  test('trims both ends', async () => {
    await settingsAsync.set('vertex_batch_location', '  global  ');
    expect(await settingsAsync.get('vertex_batch_location')).toBe('global');
  });

  test('preserves internal whitespace (multi-line prompt templates)', async () => {
    const promptTemplate =
      'You annotate sentiment.\n\nField rules:\n  - polarity\n  - intensity';
    await settingsAsync.set('sentiment.prompt.default', promptTemplate);
    expect(await settingsAsync.get('sentiment.prompt.default')).toBe(promptTemplate);
  });

  test('whitespace-only value becomes empty string', async () => {
    await settingsAsync.set('some_key', '   \n  ');
    expect(await settingsAsync.get('some_key')).toBe('');
  });

  test('empty string stays empty', async () => {
    await settingsAsync.set('some_key', '');
    expect(await settingsAsync.get('some_key')).toBe('');
  });

  test('null pass-through (clearing a setting)', async () => {
    await settingsAsync.set('some_key', 'value');
    await settingsAsync.set('some_key', null);
    expect(await settingsAsync.get('some_key')).toBeNull();
  });

  test('trims SECRET values before encryption (paste-with-newline scenario)', async () => {
    // Stub the encryptSecret behavior is hard; the observable effect is that
    // after set/get round-trip, the value is the trimmed plaintext, not the
    // padded plaintext. The encryption layer round-trips correctly only when
    // we trim BEFORE encrypting (otherwise the user sees their key with
    // whitespace re-decrypted).
    await settingsAsync.set('openai_api_key', 'sk-test-12345\n');
    expect(await settingsAsync.get('openai_api_key')).toBe('sk-test-12345');
  });
});
