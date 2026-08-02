'use strict';

const config = require('../../config');
const { encryptSecret, decryptSecret } = require('../../utils/secrets');

module.exports = (db, runAsync, getAsync, allAsync, saveDatabase, run, get, all) => {
const SECRET_SETTING_KEYS = new Set([
  'openai_api_key',
  'anthropic_api_key',
  'google_api_key',
  'vertex_api_key',
  'vertex_batch_credentials_json'
]);

// ── Public-settings cache ───────────────────────────────────────────────────
// The page-shell middleware (server.js) calls `settingsAsync.getAllPublic()`
// on every request that reaches it — every HTML page view and, because
// /uploads is deliberately excluded from express.static so the authorizing
// proxy can run, every thumbnail on a browse grid. On remote Turso that is a
// full network round-trip for a table whose contents change a few times a
// year.
//
// Correctness rests on the single write funnel below: `settings.set` /
// `settingsAsync.set` are the only runtime writers (the remaining
// `INSERT OR IGNORE`/`UPDATE settings` statements all run inside
// `initializeSchema`, before any request is served), so invalidating there
// makes an admin settings edit visible on the very next render. The TTL only
// bounds staleness for a write performed by a *different* web machine, which
// is why it is short rather than unbounded.
const publicSettingsCache = { value: null, expiresAt: 0 };

function cacheTtlMs() {
  const ttl = Number(config.database.settingsCacheTtlMs);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

function readPublicSettingsCache() {
  if (!publicSettingsCache.value) return null;
  if (Date.now() >= publicSettingsCache.expiresAt) {
    publicSettingsCache.value = null;
    return null;
  }
  // Hand back a copy: callers spread these values into `res.locals` and must
  // not be able to mutate the shared entry.
  return { ...publicSettingsCache.value };
}

function writePublicSettingsCache(value) {
  const ttl = cacheTtlMs();
  if (ttl <= 0) return value;
  publicSettingsCache.value = value;
  publicSettingsCache.expiresAt = Date.now() + ttl;
  return { ...value };
}

function invalidatePublicSettingsCache() {
  publicSettingsCache.value = null;
  publicSettingsCache.expiresAt = 0;
}

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
    invalidatePublicSettingsCache();
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
    const cached = readPublicSettingsCache();
    if (cached) return cached;
    const rows = await allAsync('SELECT key, value FROM settings');
    return writePublicSettingsCache(rows.reduce((acc, { key, value }) => {
      if (!SECRET_SETTING_KEYS.has(key)) acc[key] = value;
      return acc;
    }, {}));
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
    // Trim leading/trailing whitespace on string values before storage.
    // Operators frequently paste config values (bucket names, model ids, API
    // keys) with stray whitespace; the GCS API rejects bucket names with
    // leading spaces, OpenAI rejects keys with trailing newlines, etc. Trim
    // here at the single setter funnel so every caller benefits without
    // duplicating defensive trims across admin routes and config resolvers.
    // Internal whitespace (e.g. inside multi-line prompt templates) is
    // preserved — .trim() only touches the very start and end of the value.
    const normalized = typeof value === 'string' ? value.trim() : value;
    const storedValue = SECRET_SETTING_KEYS.has(key) && normalized != null && normalized !== ''
      ? encryptSecret(normalized)
      : normalized;
    await runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, storedValue]);
    invalidatePublicSettingsCache();
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
    settingsAsync,
    invalidatePublicSettingsCache
  };
};
