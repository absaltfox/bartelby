'use strict';

const { encryptSecret, decryptSecret } = require('../../utils/secrets');

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all) => {
const SECRET_SETTING_KEYS = new Set([
  'openai_api_key',
  'anthropic_api_key',
  'google_api_key',
  'vertex_api_key',
  'vertex_batch_credentials_json'
]);

const settings = {
  get(key) {
    const row = get('SELECT value FROM settings WHERE key = ?', [key]);
    if (!row) return null;
    if (!SECRET_SETTING_KEYS.has(key) || row.value == null) return row.value;
    return decryptSecret(row.value);
  },

  getAll() {
    const rows = all('SELECT key, value FROM settings');
    return rows.reduce((acc, { key, value }) => {
      acc[key] = SECRET_SETTING_KEYS.has(key) && value != null
        ? decryptSecret(value)
        : value;
      return acc;
    }, {});
  },

  getAllPublic() {
    const rows = all('SELECT key, value FROM settings');
    return rows.reduce((acc, { key, value }) => {
      if (!SECRET_SETTING_KEYS.has(key)) acc[key] = value;
      return acc;
    }, {});
  },

  getMany(keys) {
    const safeKeys = [...new Set((keys || []).map((key) => String(key || '').trim()).filter(Boolean))];
    if (!safeKeys.length) return {};
    const placeholders = safeKeys.map(() => '?').join(',');
    const rows = all(`SELECT key, value FROM settings WHERE key IN (${placeholders})`, safeKeys);
    return rows.reduce((acc, { key, value }) => {
      acc[key] = SECRET_SETTING_KEYS.has(key) && value != null
        ? decryptSecret(value)
        : value;
      return acc;
    }, {});
  },

  getSecretPresence(keys = [...SECRET_SETTING_KEYS]) {
    const safeKeys = [...new Set((keys || []).map((key) => String(key || '').trim()).filter((key) => SECRET_SETTING_KEYS.has(key)))];
    if (!safeKeys.length) return {};
    const placeholders = safeKeys.map(() => '?').join(',');
    const rows = all(`SELECT key, value FROM settings WHERE key IN (${placeholders})`, safeKeys);
    return rows.reduce((acc, { key, value }) => {
      acc[key] = value != null && value !== '';
      return acc;
    }, {});
  },

  set(key, value) {
    const storedValue = SECRET_SETTING_KEYS.has(key) && value != null && value !== ''
      ? encryptSecret(value)
      : value;
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, storedValue]);
  },

  hasSystemKeyForProvider(provider) {
    if (provider === 'openai') return !!(this.get('openai_api_key') || process.env.OPENAI_API_KEY);
    if (provider === 'claude') return !!(this.get('anthropic_api_key') || process.env.ANTHROPIC_API_KEY);
    if (provider === 'gemini') return !!(this.get('google_api_key') || process.env.GOOGLE_GENERATIVE_AI_API_KEY);
    if (provider === 'vertex') return !!(this.get('vertex_api_key') || process.env.GOOGLE_VERTEX_API_KEY);
    if (provider === 'ollama' || provider === 'lmstudio') return true;
    return false;
  }
};

const settingsAsync = {
  async get(key) {
    const row = await getAsync('SELECT value FROM settings WHERE key = ?', [key]);
    if (!row) return null;
    if (!SECRET_SETTING_KEYS.has(key) || row.value == null) return row.value;
    return decryptSecret(row.value);
  },

  async getAll() {
    const rows = await allAsync('SELECT key, value FROM settings');
    return rows.reduce((acc, { key, value }) => {
      acc[key] = SECRET_SETTING_KEYS.has(key) && value != null
        ? decryptSecret(value)
        : value;
      return acc;
    }, {});
  },

  async getAllPublic() {
    const rows = await allAsync('SELECT key, value FROM settings');
    return rows.reduce((acc, { key, value }) => {
      if (!SECRET_SETTING_KEYS.has(key)) acc[key] = value;
      return acc;
    }, {});
  },

  async getMany(keys) {
    const safeKeys = [...new Set((keys || []).map((key) => String(key || '').trim()).filter(Boolean))];
    if (!safeKeys.length) return {};
    const placeholders = safeKeys.map(() => '?').join(',');
    const rows = await allAsync(`SELECT key, value FROM settings WHERE key IN (${placeholders})`, safeKeys);
    return rows.reduce((acc, { key, value }) => {
      acc[key] = SECRET_SETTING_KEYS.has(key) && value != null
        ? decryptSecret(value)
        : value;
      return acc;
    }, {});
  },

  async getSecretPresence(keys = [...SECRET_SETTING_KEYS]) {
    const safeKeys = [...new Set((keys || []).map((key) => String(key || '').trim()).filter((key) => SECRET_SETTING_KEYS.has(key)))];
    if (!safeKeys.length) return {};
    const placeholders = safeKeys.map(() => '?').join(',');
    const rows = await allAsync(`SELECT key, value FROM settings WHERE key IN (${placeholders})`, safeKeys);
    return rows.reduce((acc, { key, value }) => {
      acc[key] = value != null && value !== '';
      return acc;
    }, {});
  },

  async set(key, value) {
    const storedValue = SECRET_SETTING_KEYS.has(key) && value != null && value !== ''
      ? encryptSecret(value)
      : value;
    await runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, storedValue]);
  },

  async hasSystemKeyForProvider(provider) {
    if (provider === 'openai') return !!((await this.get('openai_api_key')) || process.env.OPENAI_API_KEY);
    if (provider === 'claude') return !!((await this.get('anthropic_api_key')) || process.env.ANTHROPIC_API_KEY);
    if (provider === 'gemini') return !!((await this.get('google_api_key')) || process.env.GOOGLE_GENERATIVE_AI_API_KEY);
    if (provider === 'vertex') return !!((await this.get('vertex_api_key')) || process.env.GOOGLE_VERTEX_API_KEY);
    if (provider === 'ollama' || provider === 'lmstudio') return true;
    return false;
  }
};


  return {
    SECRET_SETTING_KEYS,
    settings,
    settingsAsync
  };
};
