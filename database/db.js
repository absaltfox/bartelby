const {
  canEncryptSecrets,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret
} = require('../utils/secrets');
const crypto = require('crypto');
const { hashOtpCode } = require('../utils/mfa');
const { initDriver } = require('./driver');

let db = null;
const SECRET_SETTING_KEYS = new Set(['openai_api_key', 'anthropic_api_key']);
const USER_SECRET_PROVIDERS = new Set(['openai', 'claude']);

// ── Migrations ──────────────────────────────────────────────────────────────
// Each entry is applied exactly once, tracked via PRAGMA user_version in the
// DB file itself. To add a new migration, append to this array — never edit
// existing entries. schema.sql is kept as a human-readable reference only.

const MIGRATIONS = [
  // v1 — base schema
  `
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    date_created TEXT,
    description TEXT,
    image_path TEXT,
    metadata JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    transcriber TEXT,
    version INTEGER DEFAULT 1,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES documents(id)
  );
  CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    content TEXT NOT NULL,
    position_start INTEGER,
    position_end INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id)
  );
  CREATE INDEX IF NOT EXISTS idx_transcripts_document_id ON transcripts(document_id);
  CREATE INDEX IF NOT EXISTS idx_annotations_transcript_id ON annotations(transcript_id);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS document_collections (
    document_id INTEGER NOT NULL,
    collection_id INTEGER NOT NULL,
    PRIMARY KEY (document_id, collection_id),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS user_collection_access (
    user_id INTEGER NOT NULL,
    collection_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, collection_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('default_provider', 'openai'),
    ('openai_model', 'gpt-4o'),
    ('anthropic_model', 'claude-3-5-sonnet-20241022'),
    ('ollama_base_url', 'http://localhost:11434'),
    ('ollama_model', 'llava'),
    ('lmstudio_base_url', 'http://localhost:1234/v1'),
    ('lmstudio_model', 'local-model'),
    ('transcription_prompt', 'You are an expert in historical document transcription and paleography. Transcribe all handwritten and printed text from the document image with high accuracy.

Rules:
- Transcribe ALL visible text verbatim, preserving original spelling, punctuation, and capitalization
- Use [illegible] for text that cannot be read with confidence
- Use [unclear: word?] when a word is uncertain
- Mark struck-through text as ~~text~~
- Mark interlinear additions in {curly braces}

Respond ONLY with a valid JSON object — no markdown fences, no commentary — in this exact shape:
{
  "transcription": "<full verbatim text>",
  "metadata": {
    "title": "<document title or null>",
    "date_created": "<date as written, e.g. March 15 1847, or null>",
    "document_type": "<letter|ledger|deed|diary|legal|receipt|other or null>",
    "author": "<author/signer or null>",
    "location": "<place of origin or null>",
    "condition": "<good|fair|poor or null>"
  },
  "notes": "<observations about illegible sections or difficulties, or null>"
}')
  `,

  // v2 — user status and access_all flag
  `
  ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE users ADD COLUMN access_all INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET status = 'active' WHERE status IS NULL;
  UPDATE users SET access_all = 0 WHERE access_all IS NULL
  `,

  // v3 — public/private collections
  `
  ALTER TABLE collections ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0
  `,

  // v4 — transcript provenance (paradata)
  `
  ALTER TABLE transcripts ADD COLUMN provider TEXT;
  ALTER TABLE transcripts ADD COLUMN model TEXT;
  ALTER TABLE transcripts ADD COLUMN prompt TEXT;
  ALTER TABLE transcripts ADD COLUMN temperature REAL;
  ALTER TABLE transcripts ADD COLUMN initiated_by TEXT;
  ALTER TABLE transcripts ADD COLUMN run_duration_ms INTEGER
  `,

  // v5 — background transcription jobs
  `
  CREATE TABLE IF NOT EXISTS transcription_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    provider TEXT,
    model TEXT,
    temperature REAL,
    initiated_by TEXT,
    image_path TEXT NOT NULL,
    additional_image_paths TEXT,
    log TEXT NOT NULL DEFAULT '',
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_transcription_jobs_status ON transcription_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_transcription_jobs_document_id ON transcription_jobs(document_id)
  `,

  // v6 — import jobs (background PDF processing)
  `
  CREATE TABLE IF NOT EXISTS import_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'queued',
    original_name TEXT,
    file_path TEXT,
    page_count INTEGER,
    pages TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status)
  `,

  // v7 — add submitted flag to import_jobs
  `ALTER TABLE import_jobs ADD COLUMN submitted INTEGER NOT NULL DEFAULT 0`,

  // v8 — track rendering progress for import jobs
  `ALTER TABLE import_jobs ADD COLUMN pages_rendered INTEGER NOT NULL DEFAULT 0`,

  // v9 — collection preview image (selected document)
  `ALTER TABLE collections ADD COLUMN preview_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL`,

  // v10 — invites, private provider keys, MFA, and job credential provenance
  `
  ALTER TABLE users ADD COLUMN can_use_system_api_keys INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN mfa_method TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE users ADD COLUMN mfa_totp_secret TEXT;
  ALTER TABLE users ADD COLUMN mfa_email_otp_hash TEXT;
  ALTER TABLE users ADD COLUMN mfa_email_otp_expires_at DATETIME;
  ALTER TABLE users ADD COLUMN mfa_email_otp_sent_at DATETIME;
  ALTER TABLE users ADD COLUMN invite_id INTEGER;
  UPDATE users
    SET can_use_system_api_keys = CASE WHEN role = 'admin' THEN 1 ELSE 0 END
    WHERE can_use_system_api_keys IS NULL;
  CREATE TABLE IF NOT EXISTS user_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'user',
    access_all INTEGER NOT NULL DEFAULT 0,
    can_use_system_api_keys INTEGER NOT NULL DEFAULT 0,
    collection_ids TEXT,
    invited_by INTEGER,
    accepted_by_user_id INTEGER,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    accepted_at DATETIME,
    revoked_at DATETIME,
    FOREIGN KEY (invited_by) REFERENCES users(id),
    FOREIGN KEY (accepted_by_user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(email);
  CREATE INDEX IF NOT EXISTS idx_user_invites_token_hash ON user_invites(token_hash);
  CREATE TABLE IF NOT EXISTS user_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_user_api_keys_user_id ON user_api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_api_keys_provider ON user_api_keys(provider);
  ALTER TABLE transcription_jobs ADD COLUMN provider_key_scope TEXT;
  ALTER TABLE transcription_jobs ADD COLUMN user_api_key_id INTEGER;
  ALTER TABLE transcription_jobs ADD COLUMN requested_by_user_id INTEGER;
  `,

  // v11 — admin-initiated password reset tokens
  `
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME,
    revoked_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash ON password_reset_tokens(token_hash);
  `,
  // v12 — track password changes for session invalidation
  `
  ALTER TABLE users ADD COLUMN password_changed_at DATETIME;
  `,

  // v13 — track Fly machine ID for ephemeral PDF workers
  `ALTER TABLE import_jobs ADD COLUMN machine_id TEXT`,

  // v14 — MFA remember tokens (skip MFA for trusted devices)
  `
  CREATE TABLE IF NOT EXISTS mfa_remember_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_mfa_remember_user ON mfa_remember_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_mfa_remember_hash ON mfa_remember_tokens(token_hash)
  `,

  // v15 — per-collection roles (viewer, editor, manager)
  `
  ALTER TABLE user_collection_access ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'
  `,

  // v16 — best transcript flag + created_by tracking
  `
  ALTER TABLE transcripts ADD COLUMN is_best INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE transcripts ADD COLUMN created_by_user_id INTEGER REFERENCES users(id);
  CREATE INDEX IF NOT EXISTS idx_transcripts_best ON transcripts(document_id, is_best);
  UPDATE transcripts SET is_best = 1
    WHERE id IN (
      SELECT id FROM (
        SELECT id, document_id,
          ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY created_at DESC) as rn
        FROM transcripts
      ) ranked WHERE rn = 1
    )
  `,

  // v17 — per-collection roles in invites
  `
  ALTER TABLE user_invites ADD COLUMN collection_roles TEXT
  `,

  // v18 — track which user initiated each import job
  `
  ALTER TABLE import_jobs ADD COLUMN user_id INTEGER REFERENCES users(id)
  `,

  // v19 — per-collection export permission
  `
  ALTER TABLE collections ADD COLUMN allow_export INTEGER NOT NULL DEFAULT 0
  `,

  // v20 — document event history (audit log)
  `
  CREATE TABLE IF NOT EXISTS document_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    user_id INTEGER,
    user_name TEXT,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_document_events_document_id ON document_events(document_id);
  CREATE INDEX IF NOT EXISTS idx_document_events_created_at ON document_events(created_at)
  `,

  // v21 — store credential scope on transcripts for provenance
  `ALTER TABLE transcripts ADD COLUMN provider_key_scope TEXT`,

  // v22 — editable default transcription prompt
  `
  INSERT OR IGNORE INTO settings (key, value) VALUES (
    'transcription_prompt',
    'You are an expert in historical document transcription and paleography. Transcribe all handwritten and printed text from the document image with high accuracy.

Rules:
- Transcribe ALL visible text verbatim, preserving original spelling, punctuation, and capitalization
- Use [illegible] for text that cannot be read with confidence
- Use [unclear: word?] when a word is uncertain
- Mark struck-through text as ~~text~~
- Mark interlinear additions in {curly braces}

Respond ONLY with a valid JSON object — no markdown fences, no commentary — in this exact shape:
{
  "transcription": "<full verbatim text>",
  "metadata": {
    "title": "<document title or null>",
    "date_created": "<date as written, e.g. March 15 1847, or null>",
    "document_type": "<letter|ledger|deed|diary|legal|receipt|other or null>",
    "author": "<author/signer or null>",
    "location": "<place of origin or null>",
    "condition": "<good|fair|poor or null>"
  },
  "notes": "<observations about illegible sections or difficulties, or null>"
}'
  )
  `,

  // v23 — transcript page segmentation metadata for multipage comparison
  `
  ALTER TABLE transcripts ADD COLUMN page_segments TEXT
  `,

  // v24 — world-public collections (visible to unauthenticated visitors)
  `
  ALTER TABLE collections ADD COLUMN is_world_public INTEGER NOT NULL DEFAULT 0
  `,

  // v25 — per-collection AI page-grouping suggestions during PDF import
  `
  ALTER TABLE collections ADD COLUMN auto_group_pages INTEGER NOT NULL DEFAULT 0
  `,

  // v26 — optional vision model override on personal API keys
  `
  ALTER TABLE user_api_keys ADD COLUMN vision_model TEXT
  `,

  // v27 — optional primary model override on personal API keys
  `
  ALTER TABLE user_api_keys ADD COLUMN model TEXT
  `,

  // v28 — persist manual/AI grouping state on import jobs
  `
  ALTER TABLE import_jobs ADD COLUMN grouping_state TEXT
  `,

  // v29 — optional utility model override on personal API keys (title/summary generation)
  `
  ALTER TABLE user_api_keys ADD COLUMN utility_model TEXT
  `,

  // v30 — checkpoint partial page results so retried jobs resume from the failed page
  `
  ALTER TABLE transcription_jobs ADD COLUMN partial_results TEXT
  `,

  // v31 — token usage and estimated cost on transcripts
  `
  ALTER TABLE transcripts ADD COLUMN input_tokens INTEGER;
  ALTER TABLE transcripts ADD COLUMN output_tokens INTEGER;
  ALTER TABLE transcripts ADD COLUMN cost_usd REAL
  `,

  // v32 — cost-per-token rates on personal API keys (per million tokens)
  `
  ALTER TABLE user_api_keys ADD COLUMN input_cost_per_mtok REAL;
  ALTER TABLE user_api_keys ADD COLUMN output_cost_per_mtok REAL
  `,

  // v33 — model-reported transcription confidence (0-100)
  `
  ALTER TABLE transcripts ADD COLUMN confidence INTEGER
  `
];

// ── Core database setup ─────────────────────────────────────────────────────

async function initDatabase() {
  if (db) return db;
  db = await initDriver();
  return db;
}

// Debounce saveDatabase so rapid back-to-back writes (e.g. appendLog during
// a running transcription job) only trigger one full serialization per 500ms.
// Each call resets the timer; the promise returned always resolves once the
// actual persist fires.
let _saveTimer = null;
let _saveResolve = null;
let _saveReject = null;
let _savePending = null;
function saveDatabase() {
  if (!db) return Promise.resolve();
  // If no pending flush, create one
  if (!_savePending) {
    _savePending = new Promise((resolve, reject) => {
      _saveResolve = resolve;
      _saveReject = reject;
    });
  }
  // Always reset the timer so bursts collapse into one write
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const resolve = _saveResolve;
    const reject = _saveReject;
    _savePending = null;
    _saveTimer = null;
    _saveResolve = null;
    _saveReject = null;
    try { resolve(db.persist()); } catch (e) {
      console.error('[db] Failed to persist database:', e.message);
      resolve(); // resolve so fire-and-forget callers don't get unhandled rejections
    }
  }, 300);
  return _savePending;
}

async function initializeSchema() {
  await initDatabase();

  const currentVersion = await db.getSchemaVersion();

  if (currentVersion < MIGRATIONS.length) {
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      console.log(`[db] applying migration ${version}/${MIGRATIONS.length}`);

      const statements = MIGRATIONS[i]
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

      for (const stmt of statements) {
        try {
          await db.run(stmt);
        } catch (e) {
          // ALTER TABLE ADD COLUMN on an already-existing column is safe to skip.
          // CREATE TABLE/INDEX IF NOT EXISTS never throws, but guard defensively.
          if (e.message.includes('duplicate column name') || e.message.includes('already exists')) {
            console.log(`[db]   already exists, skipping: ${stmt.substring(0, 60)}`);
          } else {
            throw new Error(`Migration ${version} failed: ${e.message}\n  Statement: ${stmt.substring(0, 120)}`);
          }
        }
      }

      const safeVersion = Number.isInteger(version) ? version : parseInt(version, 10);
      await db.setSchemaVersion(safeVersion);
      console.log(`[db] migration ${version} complete`);
    }

    await saveDatabase();
  }

  // Recover from unclean shutdown: any jobs left in processing/running
  // can never complete (the process that was handling them is gone).
  // Skip jobs with a machine_id — they run on ephemeral Fly machines
  // and may still be processing on a separate VM.
  const staleImports = await get("SELECT COUNT(*) as count FROM import_jobs WHERE status = 'processing' AND machine_id IS NULL");
  const staleImportCount = staleImports?.count || 0;
  if (staleImportCount > 0) {
    await db.run("UPDATE import_jobs SET status = 'failed', error = 'Server restarted during processing', completed_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND machine_id IS NULL");
    console.log(`[db] Marked ${staleImportCount} stale import job(s) as failed`);
  }

  const staleTranscriptions = await get("SELECT COUNT(*) as count FROM transcription_jobs WHERE status = 'running'");
  const staleTranscriptionCount = staleTranscriptions?.count || 0;
  if (staleTranscriptionCount > 0) {
    await db.run("UPDATE transcription_jobs SET status = 'failed', error = 'Server restarted during processing', completed_at = CURRENT_TIMESTAMP WHERE status = 'running'");
    console.log(`[db] Marked ${staleTranscriptionCount} stale transcription job(s) as failed`);
  }

  if (staleImportCount > 0 || staleTranscriptionCount > 0) {
    await saveDatabase();
  }

  await migrateEncryptedSettings();

  return db;
}

async function migrateEncryptedSettings() {
  if (!canEncryptSecrets()) return;

  const rows = await all('SELECT key, value FROM settings');
  let mutated = false;

  for (const row of rows) {
    if (!SECRET_SETTING_KEYS.has(row.key) || !row.value || isEncryptedSecret(row.value)) continue;
    await db.run('UPDATE settings SET value = ? WHERE key = ?', [encryptSecret(row.value), row.key]);
    mutated = true;
  }

  if (mutated) {
    await saveDatabase();
    console.log('[security] Encrypted stored provider secrets in settings');
  }
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function normalizeCollectionIds(collectionIds) {
  if (!Array.isArray(collectionIds)) return [];
  return [...new Set(collectionIds.map(Number).filter(Number.isInteger))];
}

function parseInviteCollectionIds(value) {
  if (!value) return [];
  try {
    return normalizeCollectionIds(JSON.parse(value));
  } catch {
    return [];
  }
}

// ── Transcription Jobs ──────────────────────────────────────────────────────

const transcriptionJobs = {
  create({
    document_id,
    provider,
    model,
    temperature,
    initiated_by,
    image_path,
    additional_image_paths,
    provider_key_scope,
    user_api_key_id,
    requested_by_user_id
  }) {
    const result = run(`
      INSERT INTO transcription_jobs
        (document_id, provider, model, temperature, initiated_by, image_path, additional_image_paths, provider_key_scope, user_api_key_id, requested_by_user_id, status, log)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '')
    `, [
      document_id,
      provider || null,
      model || null,
      temperature != null ? temperature : null,
      initiated_by || null,
      image_path,
      additional_image_paths ? JSON.stringify(additional_image_paths) : null,
      provider_key_scope || null,
      user_api_key_id || null,
      requested_by_user_id || null
    ]);
    return result.lastInsertRowid;
  },

  getNextQueued() {
    return get("SELECT * FROM transcription_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1");
  },

  markRunning(id) {
    db.run("UPDATE transcription_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ?", [id]);
    saveDatabase();
  },

  appendLog(id, text) {
    db.run("UPDATE transcription_jobs SET log = log || ? WHERE id = ?", [text, id]);
    saveDatabase();
  },

  markDone(id) {
    db.run("UPDATE transcription_jobs SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    saveDatabase();
  },

  markFailed(id, error) {
    db.run("UPDATE transcription_jobs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?", [error || 'Unknown error', id]);
    saveDatabase();
  },

  requeueForRetry(id) {
    db.run("UPDATE transcription_jobs SET status = 'queued', error = NULL, started_at = NULL, completed_at = NULL WHERE id = ?", [id]);
    saveDatabase();
  },

  getAll() {
    return all(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      ORDER BY j.created_at DESC
    `);
  },

  getById(id) {
    return get(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.id = ?
    `, [id]);
  },

  getCounts() {
    const rows = all("SELECT status, COUNT(*) as count FROM transcription_jobs GROUP BY status");
    const counts = { queued: 0, running: 0, done: 0, failed: 0, total: 0 };
    rows.forEach(r => {
      counts[r.status] = (counts[r.status] || 0) + r.count;
      counts.total += r.count;
    });
    return counts;
  },

  retry(id) {
    db.run("UPDATE transcription_jobs SET status = 'queued', error = NULL, started_at = NULL, completed_at = NULL WHERE id = ? AND status = 'failed'", [id]);
    saveDatabase();
  },

  delete(id) {
    return run("DELETE FROM transcription_jobs WHERE id = ?", [id]);
  },

  getPendingForDocument(docId) {
    return get("SELECT * FROM transcription_jobs WHERE document_id = ? AND status IN ('queued', 'running') LIMIT 1", [docId]);
  }
};

// ── Import Jobs (background PDF processing) ─────────────────────────────

const importJobs = {
  create({ original_name, file_path }) {
    const result = run(`
      INSERT INTO import_jobs (original_name, file_path, status)
      VALUES (?, ?, 'processing')
    `, [original_name || null, file_path || null]);
    return result.lastInsertRowid;
  },

  updateProgress(id, { page_count, pages_rendered }) {
    if (page_count != null) {
      db.run("UPDATE import_jobs SET page_count = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", [page_count, id]);
    }
    if (pages_rendered != null) {
      db.run("UPDATE import_jobs SET pages_rendered = ? WHERE id = ?", [pages_rendered, id]);
    }
    // Don't call saveDatabase() on every progress tick — it's expensive for sql.js.
    // The in-memory DB is already updated; it'll be persisted on markDone/markFailed.
  },

  markDone(id, pages) {
    db.run("UPDATE import_jobs SET status = 'done', pages = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [JSON.stringify(pages), id]);
    saveDatabase();
  },

  markFailed(id, error) {
    db.run("UPDATE import_jobs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [error || 'Unknown error', id]);
    saveDatabase();
  },

  getById(id) {
    return get('SELECT * FROM import_jobs WHERE id = ?', [id]);
  },

  getAll() {
    return all('SELECT * FROM import_jobs ORDER BY created_at DESC');
  },

  getCounts() {
    const rows = all("SELECT status, COUNT(*) as count FROM import_jobs GROUP BY status");
    const counts = { processing: 0, done: 0, failed: 0, total: 0 };
    rows.forEach(r => {
      counts[r.status] = (counts[r.status] || 0) + r.count;
      counts.total += r.count;
    });
    return counts;
  },

  updateMachineId(id, machineId) {
    db.run("UPDATE import_jobs SET machine_id = ? WHERE id = ?", [machineId, id]);
  },

  markSubmitted(id) {
    db.run("UPDATE import_jobs SET submitted = 1 WHERE id = ?", [id]);
    saveDatabase();
  },

  updateGroupingState(id, groupingState) {
    db.run("UPDATE import_jobs SET grouping_state = ? WHERE id = ?", [
      groupingState ? JSON.stringify(groupingState) : null,
      id
    ]);
    saveDatabase();
  },

  delete(id) {
    return run("DELETE FROM import_jobs WHERE id = ?", [id]);
  }
};

// Helper to run query and return all results
function all(sql, params = []) {
  return db.all(sql, params);
}

// Helper to run query and return first result
function get(sql, params = []) {
  return db.get(sql, params);
}

// Helper to run insert/update/delete
function run(sql, params = []) {
  const result = db.run(sql, params);
  saveDatabase();
  return result;
}

async function allAsync(sql, params = []) {
  return await db.all(sql, params);
}

async function getAsync(sql, params = []) {
  return await db.get(sql, params);
}

async function runAsync(sql, params = []) {
  const result = await db.run(sql, params);
  await saveDatabase();
  return result;
}

// ── Documents ──────────────────────────────────────────────────────────────

const documents = {
  buildAccessConditions(opts = {}) {
    const { userId, isAdmin, accessAll } = opts;
    const conditions = [];
    const params = [];

    if (!isAdmin && !accessAll) {
      if (userId) {
        // Authenticated user: world-public + all-users + explicitly granted
        conditions.push(`d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
          WHERE uca.user_id = ?
          UNION
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_public = 1
        )`);
        params.push(userId);
      } else {
        // Unauthenticated visitor: world-public only
        conditions.push(`d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )`);
      }
    }

    return { conditions, params };
  },

  buildFilterConditions(filters = {}) {
    const { collectionId, uncollected, docTypes, locations, authors, dateFrom, dateTo } = filters;
    const conditions = [];
    const params = [];

    if (uncollected) {
      conditions.push(`d.id NOT IN (SELECT document_id FROM document_collections)`);
    } else if (collectionId) {
      conditions.push(`d.id IN (SELECT document_id FROM document_collections WHERE collection_id = ?)`);
      params.push(collectionId);
    }
    if (docTypes && docTypes.length > 0) {
      const placeholders = docTypes.map(() => '?').join(',');
      conditions.push(`json_extract(d.metadata, '$.document_type') IN (${placeholders})`);
      params.push(...docTypes);
    }
    if (locations && locations.length > 0) {
      const placeholders = locations.map(() => 'LOWER(TRIM(?))').join(',');
      conditions.push(`LOWER(TRIM(json_extract(d.metadata, '$.location'))) IN (${placeholders})`);
      params.push(...locations);
    }
    if (authors && authors.length > 0) {
      const placeholders = authors.map(() => 'LOWER(TRIM(?))').join(',');
      conditions.push(`LOWER(TRIM(json_extract(d.metadata, '$.author'))) IN (${placeholders})`);
      params.push(...authors);
    }
    if (dateFrom) {
      conditions.push(`d.date_created >= ?`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`d.date_created <= ?`);
      params.push(dateTo);
    }

    return { conditions, params };
  },

  // opts: { userId, isAdmin, accessAll } — omit or set isAdmin to bypass filtering
  getAll(limit = 20, offset = 0, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll) {
      return all(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }

    if (!userId) {
      // Unauthenticated: world-public only
      return all(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        WHERE d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }

    return all(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      WHERE d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
        UNION
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_public = 1
      )
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, limit, offset]);
  },

  getById(id) {
    return get('SELECT * FROM documents WHERE id = ?', [id]);
  },

  getByIds(ids, limit = 25, offset = 0) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return all(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      WHERE d.id IN (${placeholders})
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...ids, limit, offset]);
  },

  // Check if a user can access a specific document
  canAccess(docId, userId, isAdmin, accessAll) {
    if (isAdmin || accessAll) return true;
    if (!userId) {
      // Unauthenticated: only world-public
      const row = get(`
        SELECT 1 FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE dc.document_id = ? AND col.is_world_public = 1
        LIMIT 1
      `, [docId]);
      return !!row;
    }
    const row = get(`
      SELECT 1 FROM document_collections dc
      INNER JOIN collections col ON dc.collection_id = col.id
      WHERE dc.document_id = ? AND (
        col.is_public = 1
        OR dc.collection_id IN (
          SELECT collection_id FROM user_collection_access WHERE user_id = ?
        )
      )
      LIMIT 1
    `, [docId, userId]);
    return !!row;
  },

  getCount(opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll) {
      const result = get('SELECT COUNT(*) as count FROM documents');
      return result ? result.count : 0;
    }

    if (!userId) {
      // Unauthenticated: count only world-public documents
      const result = get(`
        SELECT COUNT(DISTINCT d.id) as count
        FROM documents d
        WHERE d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )
      `);
      return result ? result.count : 0;
    }

    const result = get(`
      SELECT COUNT(DISTINCT d.id) as count
      FROM documents d
      WHERE d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
        UNION
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_public = 1
      )
    `, [userId]);
    return result ? result.count : 0;
  },

  getUncollectedCount(opts = {}) {
    const { userId, isAdmin, accessAll } = opts;
    let accessClause = '';
    const params = [];
    if (!isAdmin && !accessAll && userId) {
      // Uncollected docs are only visible to admins in practice,
      // but include access check for safety
      accessClause = '';
    }
    const result = get(`
      SELECT COUNT(*) as count FROM documents d
      WHERE d.id NOT IN (SELECT document_id FROM document_collections)
    `);
    return result ? result.count : 0;
  },

  getDistinctTypes() {
    return all(`
      SELECT DISTINCT json_extract(metadata, '$.document_type') as doc_type
      FROM documents
      WHERE json_extract(metadata, '$.document_type') IS NOT NULL
        AND json_extract(metadata, '$.document_type') != ''
      ORDER BY doc_type
    `).map(r => r.doc_type);
  },

  getDistinctTypesFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.document_type') IS NOT NULL`,
      `json_extract(d.metadata, '$.document_type') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    return all(`
      SELECT DISTINCT json_extract(d.metadata, '$.document_type') as doc_type
      FROM documents d
      ${where}
      ORDER BY doc_type
    `, params).map(r => r.doc_type);
  },

  getDistinctLocations() {
    return all(`
      SELECT DISTINCT json_extract(metadata, '$.location') as location
      FROM documents
      WHERE json_extract(metadata, '$.location') IS NOT NULL
        AND json_extract(metadata, '$.location') != ''
      ORDER BY location
    `).map(r => r.location);
  },

  getDistinctLocationsFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.location') IS NOT NULL`,
      `json_extract(d.metadata, '$.location') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    return all(`
      SELECT DISTINCT json_extract(d.metadata, '$.location') as location
      FROM documents d
      ${where}
      ORDER BY location
    `, params).map(r => r.location);
  },

  getDateRange() {
    const result = get(`
      SELECT MIN(date_created) as min_date, MAX(date_created) as max_date
      FROM documents
      WHERE date_created IS NOT NULL AND date_created != ''
    `);
    return result || { min_date: null, max_date: null };
  },

  getDateRangeFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `d.date_created IS NOT NULL`,
      `d.date_created != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const result = get(`
      SELECT MIN(d.date_created) as min_date, MAX(d.date_created) as max_date
      FROM documents d
      ${where}
    `, params);
    return result || { min_date: null, max_date: null };
  },

  getAllFiltered(limit = 20, offset = 0, opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions(filters);
    const conditions = [...access.conditions, ...scoped.conditions];
    const params = [...access.params, ...scoped.params];

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = get(`SELECT COUNT(*) as count FROM documents d ${where}`, params);
    const totalCount = countResult ? countResult.count : 0;

    const rows = all(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      ${where}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { rows, totalCount };
  },

  create(doc) {
    const result = run(`
      INSERT INTO documents (title, date_created, description, image_path, metadata)
      VALUES (?, ?, ?, ?, ?)
    `, [
      doc.title,
      doc.date_created,
      doc.description,
      doc.image_path,
      JSON.stringify(doc.metadata || {})
    ]);
    return result.lastInsertRowid;
  },

  update(id, fields) {
    const doc = get('SELECT * FROM documents WHERE id = ?', [id]);
    if (!doc) return;
    run(`
      UPDATE documents SET title = ?, date_created = ?, description = ?, metadata = ?
      WHERE id = ?
    `, [
      fields.title !== undefined ? fields.title : doc.title,
      fields.date_created !== undefined ? fields.date_created : doc.date_created,
      fields.description !== undefined ? fields.description : doc.description,
      fields.metadata !== undefined ? JSON.stringify(fields.metadata) : doc.metadata,
      id
    ]);
  },

  delete(id) {
    // Manually cascade: annotations → transcripts → document_collections → document
    const docTranscripts = all('SELECT id FROM transcripts WHERE document_id = ?', [id]);
    for (const t of docTranscripts) {
      run('DELETE FROM annotations WHERE transcript_id = ?', [t.id]);
    }
    run('DELETE FROM transcripts WHERE document_id = ?', [id]);
    run('DELETE FROM document_collections WHERE document_id = ?', [id]);
    return run('DELETE FROM documents WHERE id = ?', [id]);
  }
};

// ── Transcripts ────────────────────────────────────────────────────────────

const transcripts = {
  getByDocumentId(documentId) {
    return all(`
      SELECT * FROM transcripts
      WHERE document_id = ?
      ORDER BY version DESC
    `, [documentId]);
  },

  getById(id) {
    return get('SELECT * FROM transcripts WHERE id = ?', [id]);
  },

  create(transcript) {
    const result = run(`
      INSERT INTO transcripts (
        document_id, content, transcriber, version, notes,
        provider, model, prompt, temperature, initiated_by, run_duration_ms,
        provider_key_scope, page_segments
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      transcript.document_id,
      transcript.content,
      transcript.transcriber,
      transcript.version || 1,
      transcript.notes,
      transcript.provider || null,
      transcript.model || null,
      transcript.prompt || null,
      transcript.temperature != null ? transcript.temperature : null,
      transcript.initiated_by || null,
      transcript.run_duration_ms || null,
      transcript.provider_key_scope || null,
      transcript.page_segments ? JSON.stringify(transcript.page_segments) : null
    ]);
    return result.lastInsertRowid;
  },

  search(query, limit = 20, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    const searchTerms = query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter(term => term.length > 0);

    if (searchTerms.length === 0) return [];

    const termConditions = searchTerms.map(() =>
      '(t.content LIKE ? OR d.title LIKE ? OR d.description LIKE ?)'
    ).join(' OR ');

    const params = [];
    searchTerms.forEach(term => {
      const likeTerm = `%${term}%`;
      params.push(likeTerm, likeTerm, likeTerm);
    });

    let accessClause = '';
    if (!isAdmin && !accessAll) {
      if (userId) {
        accessClause = `AND d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
          WHERE uca.user_id = ?
          UNION
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_public = 1
        )`;
        params.push(userId);
      } else {
        accessClause = `AND d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )`;
      }
    }

    params.push(limit);

    const results = all(`
      SELECT t.*, d.title as document_title, d.id as document_id, d.description as document_description
      FROM transcripts t
      JOIN documents d ON t.document_id = d.id
      WHERE (${termConditions}) ${accessClause}
      ORDER BY t.created_at DESC
      LIMIT ?
    `, params);

    return results.map(row => {
      let snippet = '';
      for (const term of searchTerms) {
        const termLower = term.toLowerCase();
        if (row.document_title && row.document_title.toLowerCase().includes(termLower)) {
          snippet = row.content.substring(0, 200) + (row.content.length > 200 ? '...' : '');
          break;
        }
        if (row.document_description && row.document_description.toLowerCase().includes(termLower)) {
          snippet = row.document_description;
          break;
        }
        const idx = row.content.toLowerCase().indexOf(termLower);
        if (idx !== -1) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(row.content.length, idx + term.length + 80);
          snippet = (start > 0 ? '...' : '') + row.content.substring(start, end) + (end < row.content.length ? '...' : '');
          break;
        }
      }
      if (!snippet) snippet = row.content.substring(0, 200) + (row.content.length > 200 ? '...' : '');
      // Escape HTML to prevent XSS, then safely highlight search terms
      snippet = snippet
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      for (const term of searchTerms) {
        // Escape regex special chars to prevent ReDoS
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escaped})`, 'gi');
        snippet = snippet.replace(regex, '<mark>$1</mark>');
      }
      return { ...row, snippet };
    });
  }
};

// ── Annotations ────────────────────────────────────────────────────────────

const annotations = {
  getByTranscriptId(transcriptId) {
    return all(`
      SELECT * FROM annotations
      WHERE transcript_id = ?
      ORDER BY position_start, created_at
    `, [transcriptId]);
  },

  getById(id) {
    return get('SELECT * FROM annotations WHERE id = ?', [id]);
  },

  create(annotation) {
    const result = run(`
      INSERT INTO annotations (transcript_id, user_name, content, position_start, position_end)
      VALUES (?, ?, ?, ?, ?)
    `, [
      annotation.transcript_id,
      annotation.user_name,
      annotation.content,
      annotation.position_start,
      annotation.position_end
    ]);
    return result.lastInsertRowid;
  },

  delete(id) {
    return run('DELETE FROM annotations WHERE id = ?', [id]);
  }
};

// ── Users ──────────────────────────────────────────────────────────────────

const users = {
  count() {
    const result = get('SELECT COUNT(*) as n FROM users');
    return result ? result.n : 0;
  },

  findById(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },

  findByUsername(username) {
    return get('SELECT * FROM users WHERE username = ?', [username]);
  },

  findByEmail(email) {
    return get('SELECT * FROM users WHERE email = ?', [email]);
  },

  getAll() {
    return all(`
      SELECT
        id, username, email, role, status, access_all, can_use_system_api_keys,
        mfa_method, created_at
      FROM users
      ORDER BY created_at
    `);
  },

  getPending() {
    return all("SELECT id, username, email, created_at FROM users WHERE status = 'pending' ORDER BY created_at");
  },

  create({ username, email, passwordHash, role, status, accessAll, canUseSystemApiKeys, inviteId }) {
    const result = run(
      `INSERT INTO users
        (username, email, password_hash, role, status, access_all, can_use_system_api_keys, invite_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        email || null,
        passwordHash,
        role || 'user',
        status || 'pending',
        accessAll ? 1 : 0,
        canUseSystemApiKeys ? 1 : 0,
        inviteId || null
      ]
    );
    return result.lastInsertRowid;
  },

  approve(id, { role, accessAll, canUseSystemApiKeys }) {
    run(
      "UPDATE users SET status = 'active', role = ?, access_all = ?, can_use_system_api_keys = ? WHERE id = ?",
      [role || 'user', accessAll ? 1 : 0, canUseSystemApiKeys ? 1 : 0, id]
    );
  },

  reject(id) {
    run("UPDATE users SET status = 'rejected' WHERE id = ?", [id]);
  },

  setRole(id, role) {
    run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  },

  setAccessAll(id, accessAll) {
    run('UPDATE users SET access_all = ? WHERE id = ?', [accessAll ? 1 : 0, id]);
  },

  setCanUseSystemApiKeys(id, enabled) {
    run('UPDATE users SET can_use_system_api_keys = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  },

  updateEmail(id, email) {
    run('UPDATE users SET email = ? WHERE id = ?', [email || null, id]);
  },

  updatePassword(id, passwordHash) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  },

  updatePasswordChangedAt(id) {
    run('UPDATE users SET password_changed_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  setMfaMethod(id, method) {
    run('UPDATE users SET mfa_method = ? WHERE id = ?', [method || 'none', id]);
  },

  setTotpSecret(id, secret) {
    const storedSecret = secret ? encryptSecret(secret) : null;
    run('UPDATE users SET mfa_totp_secret = ? WHERE id = ?', [storedSecret, id]);
  },

  getTotpSecret(id) {
    const row = get('SELECT mfa_totp_secret FROM users WHERE id = ?', [id]);
    return row?.mfa_totp_secret ? decryptSecret(row.mfa_totp_secret) : null;
  },

  storeEmailOtp(id, code, expiresAt) {
    run(
      'UPDATE users SET mfa_email_otp_hash = ?, mfa_email_otp_expires_at = ?, mfa_email_otp_sent_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hashOtpCode(code), expiresAt, id]
    );
  },

  clearEmailOtp(id) {
    run(
      'UPDATE users SET mfa_email_otp_hash = NULL, mfa_email_otp_expires_at = NULL, mfa_email_otp_sent_at = NULL WHERE id = ?',
      [id]
    );
  },

  verifyEmailOtp(id, code) {
    const row = get('SELECT mfa_email_otp_hash, mfa_email_otp_expires_at FROM users WHERE id = ?', [id]);
    if (!row?.mfa_email_otp_hash || !row?.mfa_email_otp_expires_at) return false;
    if (new Date(row.mfa_email_otp_expires_at).getTime() < Date.now()) return false;
    const stored = Buffer.from(row.mfa_email_otp_hash);
    const computed = Buffer.from(hashOtpCode(code));
    return stored.length === computed.length && crypto.timingSafeEqual(stored, computed);
  },

  delete(id) {
    return run('DELETE FROM users WHERE id = ?', [id]);
  }
};

const userInvites = {
  create({ email, tokenHash, role, accessAll, canUseSystemApiKeys, collectionIds, invitedBy, expiresAt }) {
    const result = run(`
      INSERT INTO user_invites
        (email, token_hash, role, access_all, can_use_system_api_keys, collection_ids, invited_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      email,
      tokenHash,
      role || 'user',
      accessAll ? 1 : 0,
      canUseSystemApiKeys ? 1 : 0,
      JSON.stringify(normalizeCollectionIds(collectionIds)),
      invitedBy || null,
      expiresAt
    ]);
    return result.lastInsertRowid;
  },

  getActive() {
    return all(`
      SELECT i.*, u.username AS invited_by_username
      FROM user_invites i
      LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND datetime(i.expires_at) > datetime('now')
      ORDER BY i.created_at DESC
    `).map(invite => ({
      ...invite,
      collection_ids: parseInviteCollectionIds(invite.collection_ids)
    }));
  },

  findByTokenHash(tokenHash) {
    const invite = get('SELECT * FROM user_invites WHERE token_hash = ?', [tokenHash]);
    return invite ? { ...invite, collection_ids: parseInviteCollectionIds(invite.collection_ids) } : null;
  },

  revoke(id) {
    run('UPDATE user_invites SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  markAccepted(id, userId) {
    run(
      'UPDATE user_invites SET accepted_at = CURRENT_TIMESTAMP, accepted_by_user_id = ? WHERE id = ?',
      [userId, id]
    );
  }
};

const userApiKeys = {
  getByUserId(userId) {
    return all(`
      SELECT id, user_id, provider, label, model, vision_model, utility_model, created_at, updated_at, last_used_at
      FROM user_api_keys
      WHERE user_id = ?
      ORDER BY provider, label, created_at
    `, [userId]);
  },

  getByIdForUser(id, userId) {
    return get(`
      SELECT id, user_id, provider, label, encrypted_key, model, vision_model, utility_model, created_at, updated_at, last_used_at
      FROM user_api_keys
      WHERE id = ? AND user_id = ?
    `, [id, userId]);
  },

  create({ userId, provider, label, apiKey, model, visionModel, utilityModel }) {
    const result = run(`
      INSERT INTO user_api_keys (user_id, provider, label, encrypted_key, model, vision_model, utility_model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      provider,
      label,
      encryptSecret(apiKey),
      model || null,
      visionModel || null,
      utilityModel || null
    ]);
    return result.lastInsertRowid;
  },

  update(id, userId, { label, apiKey }) {
    if (label != null && apiKey != null) {
      run(
        'UPDATE user_api_keys SET label = ?, encrypted_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [label, encryptSecret(apiKey), id, userId]
      );
    } else if (label != null) {
      run('UPDATE user_api_keys SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [label, id, userId]);
    } else if (apiKey != null) {
      run(
        'UPDATE user_api_keys SET encrypted_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [encryptSecret(apiKey), id, userId]
      );
    }
  },

  delete(id, userId) {
    run('DELETE FROM user_api_keys WHERE id = ? AND user_id = ?', [id, userId]);
  },

  getResolvedForUser(id, userId) {
    const row = this.getByIdForUser(id, userId);
    if (!row) return null;
    return {
      ...row,
      api_key: decryptSecret(row.encrypted_key),
      masked_key: maskSecret(decryptSecret(row.encrypted_key))
    };
  },

  markUsed(id, userId) {
    run('UPDATE user_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [id, userId]);
  },

  getProviderOptionsForUser(userId) {
    return this.getByUserId(userId).reduce((acc, key) => {
      if (!acc[key.provider]) acc[key.provider] = [];
      acc[key.provider].push({
        id: key.id,
        label: key.label,
        provider: key.provider,
        type: 'user'
      });
      return acc;
    }, {});
  }
};

const passwordResetTokens = {
  create({ userId, tokenHash, createdBy, expiresAt }) {
    run(
      `UPDATE password_reset_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND datetime(expires_at) > datetime('now')`,
      [userId]
    );

    const result = run(`
      INSERT INTO password_reset_tokens (user_id, token_hash, created_by, expires_at)
      VALUES (?, ?, ?, ?)
    `, [userId, tokenHash, createdBy || null, expiresAt]);
    return result.lastInsertRowid;
  },

  findByTokenHash(tokenHash) {
    return get(`
      SELECT prt.*, u.username, u.email
      FROM password_reset_tokens prt
      INNER JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = ?
    `, [tokenHash]);
  },

  isUsable(tokenHash) {
    const row = this.findByTokenHash(tokenHash);
    if (!row) return false;
    if (row.used_at || row.revoked_at) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) return false;
    return true;
  },

  markUsed(id) {
    run('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  revokeForUser(userId) {
    run(
      `UPDATE password_reset_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      [userId]
    );
  }
};

// ── Collections ────────────────────────────────────────────────────────────

const collections = {
  getAll() {
    return all(`
      SELECT c.*,
             (SELECT COUNT(*) FROM document_collections WHERE collection_id = c.id) as document_count
      FROM collections c
      ORDER BY c.name
    `);
  },

  getAllWithThumbnails() {
    return all(`
      SELECT c.*,
             (SELECT COUNT(*) FROM document_collections WHERE collection_id = c.id) as document_count,
             COALESCE(
               (SELECT d.image_path FROM documents d WHERE d.id = c.preview_document_id),
               (SELECT d.image_path FROM documents d
                INNER JOIN document_collections dc ON d.id = dc.document_id
                WHERE dc.collection_id = c.id
                ORDER BY d.created_at DESC LIMIT 1)
             ) as thumbnail
      FROM collections c
      ORDER BY c.name
    `);
  },

  getById(id) {
    return get('SELECT * FROM collections WHERE id = ?', [id]);
  },

  canAccess(collectionId, userId, isAdmin, accessAll) {
    if (isAdmin || accessAll) return true;

    if (!userId) {
      // Unauthenticated: world-public only
      const result = get(`SELECT id FROM collections WHERE id = ? AND is_world_public = 1`, [collectionId]);
      return !!result;
    }

    const result = get(`
      SELECT c.id
      FROM collections c
      LEFT JOIN user_collection_access uca
        ON c.id = uca.collection_id AND uca.user_id = ?
      WHERE c.id = ?
        AND (c.is_public = 1 OR uca.user_id IS NOT NULL)
    `, [userId, collectionId]);

    return !!result;
  },

  create({ name, description, is_public, is_world_public, allow_export, createdBy }) {
    const result = run(
      'INSERT INTO collections (name, description, is_public, is_world_public, allow_export, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [name, description || null, is_public ? 1 : 0, is_world_public ? 1 : 0, allow_export ? 1 : 0, createdBy || null]
    );
    return result.lastInsertRowid;
  },

  update(id, { name, description, is_public, is_world_public }) {
    run('UPDATE collections SET name = ?, description = ?, is_public = ?, is_world_public = ? WHERE id = ?',
      [name, description || null, is_public ? 1 : 0, is_world_public ? 1 : 0, id]);
  },

  setPreviewDocument(id, documentId) {
    if (documentId != null) {
      const belongsToCollection = get(`
        SELECT 1
        FROM document_collections
        WHERE collection_id = ? AND document_id = ?
      `, [id, documentId]);
      if (!belongsToCollection) {
        throw new Error('Preview document must belong to the collection');
      }
    }
    run('UPDATE collections SET preview_document_id = ? WHERE id = ?',
      [documentId || null, id]);
  },

  delete(id) {
    return run('DELETE FROM collections WHERE id = ?', [id]);
  }
};

// ── Document-Collections junction ──────────────────────────────────────────

const documentCollections = {
  getByDocumentId(documentId) {
    return all(`
      SELECT c.* FROM collections c
      INNER JOIN document_collections dc ON c.id = dc.collection_id
      WHERE dc.document_id = ?
      ORDER BY c.name
    `, [documentId]);
  },

  getByCollectionId(collectionId) {
    return all(`
      SELECT dc.document_id FROM document_collections dc
      WHERE dc.collection_id = ?
    `, [collectionId]);
  },

  setForDocument(documentId, collectionIds) {
    run('DELETE FROM document_collections WHERE document_id = ?', [documentId]);
    for (const cid of (collectionIds || [])) {
      try {
        run('INSERT OR IGNORE INTO document_collections (document_id, collection_id) VALUES (?, ?)', [documentId, cid]);
      } catch (e) {}
    }
  }
};

// ── User-Collection access ──────────────────────────────────────────────────

const userCollectionAccess = {
  getByUserId(userId) {
    return all(`
      SELECT c.* FROM collections c
      INNER JOIN user_collection_access uca ON c.id = uca.collection_id
      WHERE uca.user_id = ?
      ORDER BY c.name
    `, [userId]);
  },

  getIdsByUserId(userId) {
    return all('SELECT collection_id FROM user_collection_access WHERE user_id = ?', [userId])
      .map(r => r.collection_id);
  },

  getByCollectionId(collectionId) {
    return all(`
      SELECT u.id, u.username, u.email, u.role
      FROM users u
      INNER JOIN user_collection_access uca ON u.id = uca.user_id
      WHERE uca.collection_id = ?
      ORDER BY u.username
    `, [collectionId]);
  },

  grant(userId, collectionId) {
    try {
      run('INSERT OR IGNORE INTO user_collection_access (user_id, collection_id) VALUES (?, ?)', [userId, collectionId]);
    } catch (e) {}
  },

  revoke(userId, collectionId) {
    run('DELETE FROM user_collection_access WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
  },

  setForUser(userId, collectionIds) {
    run('DELETE FROM user_collection_access WHERE user_id = ?', [userId]);
    for (const cid of (collectionIds || [])) {
      try {
        run('INSERT OR IGNORE INTO user_collection_access (user_id, collection_id) VALUES (?, ?)', [userId, cid]);
      } catch (e) {}
    }
  }
};

// ── Settings ───────────────────────────────────────────────────────────────

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

  set(key, value) {
    const storedValue = SECRET_SETTING_KEYS.has(key) && value != null && value !== ''
      ? encryptSecret(value)
      : value;
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, storedValue]);
  },

  hasSystemKeyForProvider(provider) {
    if (provider === 'openai') return !!(this.get('openai_api_key') || process.env.OPENAI_API_KEY);
    if (provider === 'claude') return !!(this.get('anthropic_api_key') || process.env.ANTHROPIC_API_KEY);
    if (provider === 'ollama' || provider === 'lmstudio') return true;
    return false;
  }
};

const transcriptionJobsAsync = {
  async create({
    document_id,
    provider,
    model,
    temperature,
    initiated_by,
    image_path,
    additional_image_paths,
    provider_key_scope,
    user_api_key_id,
    requested_by_user_id
  }) {
    const result = await runAsync(`
      INSERT INTO transcription_jobs
        (document_id, provider, model, temperature, initiated_by, image_path, additional_image_paths, provider_key_scope, user_api_key_id, requested_by_user_id, status, log)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '')
    `, [
      document_id,
      provider || null,
      model || null,
      temperature != null ? temperature : null,
      initiated_by || null,
      image_path,
      additional_image_paths ? JSON.stringify(additional_image_paths) : null,
      provider_key_scope || null,
      user_api_key_id || null,
      requested_by_user_id || null
    ]);
    return result.lastInsertRowid;
  },

  async getNextQueued() {
    return await getAsync("SELECT * FROM transcription_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1");
  },

  async markRunning(id) {
    await db.run("UPDATE transcription_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ?", [id]);
    await saveDatabase();
  },

  async appendLog(id, text) {
    await db.run("UPDATE transcription_jobs SET log = log || ? WHERE id = ?", [text, id]);
    await saveDatabase();
  },

  async markDone(id) {
    await db.run("UPDATE transcription_jobs SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    await saveDatabase();
  },

  async markFailed(id, error) {
    await db.run("UPDATE transcription_jobs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?", [error || 'Unknown error', id]);
    await saveDatabase();
  },

  async requeueForRetry(id) {
    await db.run("UPDATE transcription_jobs SET status = 'queued', error = NULL, started_at = NULL, completed_at = NULL WHERE id = ?", [id]);
    await saveDatabase();
  },

  async getById(id) {
    return await getAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.id = ?
    `, [id]);
  },

  async getPendingForDocument(docId) {
    return await getAsync("SELECT * FROM transcription_jobs WHERE document_id = ? AND status IN ('queued', 'running') LIMIT 1", [docId]);
  },

  async getAll() {
    return await allAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      ORDER BY j.created_at DESC
    `);
  },

  async getByDocumentIds(docIds) {
    if (!docIds || docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    return await allAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.document_id IN (${placeholders})
      ORDER BY j.created_at DESC
    `, docIds);
  },

  async getActiveByDocumentIds(docIds) {
    if (!docIds || docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    return await allAsync(`
      SELECT j.*, d.title as document_title
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.document_id IN (${placeholders}) AND j.status IN ('queued','running')
      ORDER BY j.created_at DESC
    `, docIds);
  },

  async savePartialResults(id, results) {
    await db.run('UPDATE transcription_jobs SET partial_results = ? WHERE id = ?', [JSON.stringify(results), id]);
  },

  async getPartialResults(id) {
    const row = await getAsync('SELECT partial_results FROM transcription_jobs WHERE id = ?', [id]);
    if (!row || !row.partial_results) return [];
    try { return JSON.parse(row.partial_results); } catch { return []; }
  },

  async clearPartialResults(id) {
    await db.run('UPDATE transcription_jobs SET partial_results = NULL WHERE id = ?', [id]);
  },

  async retry(id) {
    await db.run("UPDATE transcription_jobs SET status = 'queued', error = NULL, started_at = NULL, completed_at = NULL WHERE id = ? AND status = 'failed'", [id]);
    await saveDatabase();
  },

  async delete(id) {
    return await runAsync("DELETE FROM transcription_jobs WHERE id = ?", [id]);
  }
};

const importJobsAsync = {
  async create({ original_name, file_path, user_id }) {
    const result = await runAsync(`
      INSERT INTO import_jobs (original_name, file_path, status, user_id)
      VALUES (?, ?, 'processing', ?)
    `, [original_name || null, file_path || null, user_id || null]);
    return result.lastInsertRowid;
  },

  async updateProgress(id, { page_count, pages_rendered }) {
    if (page_count != null) {
      await db.run("UPDATE import_jobs SET page_count = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", [page_count, id]);
    }
    if (pages_rendered != null) {
      await db.run("UPDATE import_jobs SET pages_rendered = ? WHERE id = ?", [pages_rendered, id]);
    }
  },

  async markDone(id, pages) {
    await db.run("UPDATE import_jobs SET status = 'done', pages = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [JSON.stringify(pages), id]);
    await saveDatabase();
  },

  async markFailed(id, error) {
    await db.run("UPDATE import_jobs SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [error || 'Unknown error', id]);
    await saveDatabase();
  },

  async getById(id) {
    return await getAsync('SELECT * FROM import_jobs WHERE id = ?', [id]);
  },

  async getAll() {
    return await allAsync('SELECT * FROM import_jobs ORDER BY created_at DESC');
  },

  async getByUserId(userId) {
    return await allAsync('SELECT * FROM import_jobs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  },

  async updateMachineId(id, machineId) {
    await db.run("UPDATE import_jobs SET machine_id = ? WHERE id = ?", [machineId, id]);
  },

  async markSubmitted(id) {
    await db.run("UPDATE import_jobs SET submitted = 1 WHERE id = ?", [id]);
    await saveDatabase();
  },

  async updateGroupingState(id, groupingState) {
    await db.run("UPDATE import_jobs SET grouping_state = ? WHERE id = ?", [
      groupingState ? JSON.stringify(groupingState) : null,
      id
    ]);
    await saveDatabase();
  },

  async delete(id) {
    return await runAsync("DELETE FROM import_jobs WHERE id = ?", [id]);
  }
};

// Combined admin jobs helpers (paginated UNION across both job tables)
const adminJobsAsync = {
  // Overall + per-type counts (no filter applied — used for tab badges)
  async getCounts() {
    const row = await getAsync(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status IN ('running','processing') THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN job_type = 'import' THEN 1 ELSE 0 END) AS import_count,
        SUM(CASE WHEN job_type = 'transcription' THEN 1 ELSE 0 END) AS transcription_count
      FROM (
        SELECT status, 'transcription' AS job_type FROM transcription_jobs
        UNION ALL
        SELECT status, 'import' AS job_type FROM import_jobs
      )
    `);
    return {
      counts: {
        total: row.total || 0,
        queued: row.queued || 0,
        running: row.running || 0,
        done: row.done || 0,
        failed: row.failed || 0
      },
      typeCounts: {
        import: row.import_count || 0,
        transcription: row.transcription_count || 0
      }
    };
  },

  // Total count for the current filter combination (for page count)
  async getFilteredCount(statusFilter, typeFilter) {
    const statusCond = statusFilter === 'all' ? '1=1'
      : statusFilter === 'running' ? "status IN ('running','processing')"
      : "status = '" + statusFilter.replace(/[^a-z]/g, '') + "'";
    const typeCond = typeFilter === 'all' ? '1=1'
      : "job_type = '" + (typeFilter === 'import' ? 'import' : 'transcription') + "'";
    const row = await getAsync(`
      SELECT COUNT(*) AS n FROM (
        SELECT status, 'transcription' AS job_type FROM transcription_jobs
        UNION ALL
        SELECT status, 'import' AS job_type FROM import_jobs
      ) WHERE ${statusCond} AND ${typeCond}
    `);
    return row ? (row.n || 0) : 0;
  },

  // Paginated combined job list
  async getPage(limit, offset, statusFilter, typeFilter) {
    const statusCond = statusFilter === 'all' ? '1=1'
      : statusFilter === 'running' ? "status IN ('running','processing')"
      : "status = '" + statusFilter.replace(/[^a-z]/g, '') + "'";
    const typeCond = typeFilter === 'all' ? '1=1'
      : "job_type = '" + (typeFilter === 'import' ? 'import' : 'transcription') + "'";
    return await allAsync(`
      SELECT * FROM (
        SELECT j.id, j.created_at, j.status, 'transcription' AS job_type,
               j.document_id, j.started_at, j.completed_at, j.error, j.log,
               j.provider, j.model, d.title AS document_title,
               NULL AS original_name, NULL AS page_count, NULL AS pages_rendered, NULL AS submitted
        FROM transcription_jobs j
        LEFT JOIN documents d ON j.document_id = d.id
        UNION ALL
        SELECT id, created_at, status, 'import' AS job_type,
               NULL AS document_id, started_at, completed_at, error, NULL AS log,
               NULL AS provider, NULL AS model, NULL AS document_title,
               original_name, page_count, pages_rendered, submitted
        FROM import_jobs
      ) combined
      WHERE ${statusCond} AND ${typeCond}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
  },

  // Active jobs only (for AJAX polling — avoids full table scan)
  async getActive() {
    return await allAsync(`
      SELECT j.id, j.created_at, j.status, 'transcription' AS job_type,
             j.document_id, j.started_at, j.completed_at, j.error,
             j.provider, d.title AS document_title,
             NULL AS original_name, NULL AS page_count, NULL AS pages_rendered
      FROM transcription_jobs j
      LEFT JOIN documents d ON j.document_id = d.id
      WHERE j.status IN ('queued','running')
      UNION ALL
      SELECT id, created_at, status, 'import' AS job_type,
             NULL AS document_id, started_at, completed_at, error,
             NULL AS provider, NULL AS document_title,
             original_name, page_count, pages_rendered
      FROM import_jobs
      WHERE status IN ('processing','queued')
      ORDER BY created_at DESC
    `);
  }
};

const documentsAsync = {
  buildAccessConditions: documents.buildAccessConditions.bind(documents),
  buildFilterConditions: documents.buildFilterConditions.bind(documents),

  async getById(id) {
    return await getAsync('SELECT * FROM documents WHERE id = ?', [id]);
  },

  async getIdsByUploadUrl(uploadUrl) {
    if (!uploadUrl) return [];
    const rows = await allAsync(`
      SELECT DISTINCT d.id
      FROM documents d
      WHERE d.image_path = ?
         OR EXISTS (
           SELECT 1
           FROM json_each(COALESCE(d.metadata, '{}'), '$.additional_pages')
           WHERE value = ?
         )
    `, [uploadUrl, uploadUrl]);
    return rows.map((row) => row.id);
  },

  async canAccess(docId, userId, isAdmin, accessAll) {
    if (isAdmin || accessAll) return true;
    if (!userId) {
      // Unauthenticated: only world-public
      const row = await getAsync(`
        SELECT 1 FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE dc.document_id = ? AND col.is_world_public = 1
        LIMIT 1
      `, [docId]);
      return !!row;
    }
    const row = await getAsync(`
      SELECT 1 FROM document_collections dc
      INNER JOIN collections col ON dc.collection_id = col.id
      WHERE dc.document_id = ? AND (
        col.is_public = 1
        OR dc.collection_id IN (
          SELECT collection_id FROM user_collection_access WHERE user_id = ?
        )
      )
      LIMIT 1
    `, [docId, userId]);
    return !!row;
  },

  async getAll(limit = 20, offset = 0, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll) {
      return await allAsync(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }

    if (!userId) {
      // Unauthenticated: world-public only
      return await allAsync(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
        WHERE d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }

    return await allAsync(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      WHERE d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
        UNION
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_public = 1
      )
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, limit, offset]);
  },

  async getByIds(ids, limit = 25, offset = 0) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return await allAsync(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      WHERE d.id IN (${placeholders})
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...ids, limit, offset]);
  },

  async getCount(opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll) {
      const result = await getAsync('SELECT COUNT(*) as count FROM documents');
      return result ? result.count : 0;
    }

    if (!userId) {
      // Unauthenticated: count only world-public documents
      const result = await getAsync(`
        SELECT COUNT(DISTINCT d.id) as count
        FROM documents d
        WHERE d.id IN (
          SELECT dc.document_id FROM document_collections dc
          INNER JOIN collections col ON dc.collection_id = col.id
          WHERE col.is_world_public = 1
        )
      `);
      return result ? result.count : 0;
    }

    const result = await getAsync(`
      SELECT COUNT(DISTINCT d.id) as count
      FROM documents d
      WHERE d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
        UNION
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN collections col ON dc.collection_id = col.id
        WHERE col.is_public = 1
      )
    `, [userId]);
    return result ? result.count : 0;
  },

  async getUncollectedCount() {
    const result = await getAsync(`
      SELECT COUNT(*) as count FROM documents d
      WHERE d.id NOT IN (SELECT document_id FROM document_collections)
    `);
    return result ? result.count : 0;
  },

  async getDistinctTypesFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.document_type') IS NOT NULL`,
      `json_extract(d.metadata, '$.document_type') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = await allAsync(`
      SELECT DISTINCT json_extract(d.metadata, '$.document_type') as doc_type
      FROM documents d
      ${where}
      ORDER BY doc_type
    `, params);
    return rows.map(r => r.doc_type);
  },

  async getDistinctLocationsFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.location') IS NOT NULL`,
      `json_extract(d.metadata, '$.location') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = await allAsync(`
      SELECT DISTINCT json_extract(d.metadata, '$.location') as location
      FROM documents d
      ${where}
      ORDER BY location
    `, params);
    return rows.map(r => r.location);
  },

  async getDistinctAuthorsFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `json_extract(d.metadata, '$.author') IS NOT NULL`,
      `json_extract(d.metadata, '$.author') != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = await allAsync(`
      SELECT DISTINCT json_extract(d.metadata, '$.author') as author
      FROM documents d
      ${where}
      ORDER BY author
    `, params);
    return rows.map(r => r.author);
  },

  async getDateRangeFiltered(opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions({ collectionId: filters.collectionId, uncollected: filters.uncollected });
    const conditions = [
      ...access.conditions,
      ...scoped.conditions,
      `d.date_created IS NOT NULL`,
      `d.date_created != ''`
    ];
    const params = [...access.params, ...scoped.params];
    const where = `WHERE ${conditions.join(' AND ')}`;

    const result = await getAsync(`
      SELECT MIN(d.date_created) as min_date, MAX(d.date_created) as max_date
      FROM documents d
      ${where}
    `, params);
    return result || { min_date: null, max_date: null };
  },

  async getAllFiltered(limit = 20, offset = 0, opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions(filters);
    const conditions = [...access.conditions, ...scoped.conditions];
    const params = [...access.params, ...scoped.params];

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await getAsync(`SELECT COUNT(*) as count FROM documents d ${where}`, params);
    const totalCount = countResult ? countResult.count : 0;

    const rows = await allAsync(`
      SELECT d.*,
             (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      ${where}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { rows, totalCount };
  },

  async searchAdvanced(limit = 25, offset = 0, opts = {}, filters = {}) {
    const access = this.buildAccessConditions(opts);
    const scoped = this.buildFilterConditions(filters);
    const conditions = [...access.conditions, ...scoped.conditions];
    const params = [...access.params, ...scoped.params];
    const query = String(filters.query || '').trim();

    if (query) {
      const terms = query.split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        const termConditions = terms.map(() =>
          `(d.title LIKE ? OR d.description LIKE ? OR bt.content LIKE ? OR json_extract(d.metadata, '$.author') LIKE ? OR json_extract(d.metadata, '$.location') LIKE ?)`
        ).join(' AND ');
        conditions.push(`(${termConditions})`);
        terms.forEach(term => {
          const likeTerm = `%${term}%`;
          params.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
        });
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await getAsync(`
      SELECT COUNT(*) as count
      FROM documents d
      LEFT JOIN transcripts bt ON bt.document_id = d.id AND bt.is_best = 1
      ${where}
    `, params);

    const rows = await allAsync(`
      SELECT
        d.*,
        bt.id as transcript_id,
        bt.content as transcript_content,
        bt.transcriber as transcript_transcriber,
        bt.version as transcript_version,
        (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
      FROM documents d
      LEFT JOIN transcripts bt ON bt.document_id = d.id AND bt.is_best = 1
      ${where}
      ORDER BY d.date_created DESC, d.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const normalizedTerms = query ? query.split(/\s+/).filter(Boolean).map(term => term.toLowerCase()) : [];

    const decorated = rows.map(row => {
      let meta = row.metadata || {};
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch (err) { meta = {}; }
      }

      const title = row.title || '';
      const description = row.description || '';
      const transcriptContent = row.transcript_content || '';
      const author = meta.author || '';

      let snippet = description || transcriptContent.substring(0, 220);
      for (const term of normalizedTerms) {
        const fields = [title, description, transcriptContent, author];
        const match = fields.find(field => field && field.toLowerCase().includes(term));
        if (match) {
          const idx = match.toLowerCase().indexOf(term);
          const start = Math.max(0, idx - 90);
          const end = Math.min(match.length, idx + term.length + 90);
          snippet = (start > 0 ? '...' : '') + match.substring(start, end) + (end < match.length ? '...' : '');
          break;
        }
      }

      snippet = String(snippet || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      normalizedTerms.forEach(term => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        snippet = snippet.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
      });

      return { ...row, metadata: meta, snippet };
    });

    return {
      rows: decorated,
      totalCount: countResult ? countResult.count : 0
    };
  },

  async update(id, fields) {
    const doc = await getAsync('SELECT * FROM documents WHERE id = ?', [id]);
    if (!doc) return;
    await runAsync(`
      UPDATE documents SET title = ?, date_created = ?, description = ?, metadata = ?
      WHERE id = ?
    `, [
      fields.title !== undefined ? fields.title : doc.title,
      fields.date_created !== undefined ? fields.date_created : doc.date_created,
      fields.description !== undefined ? fields.description : doc.description,
      fields.metadata !== undefined ? JSON.stringify(fields.metadata) : doc.metadata,
      id
    ]);
  },

  async create(doc) {
    const result = await runAsync(`
      INSERT INTO documents (title, date_created, description, image_path, metadata)
      VALUES (?, ?, ?, ?, ?)
    `, [
      doc.title,
      doc.date_created,
      doc.description,
      doc.image_path,
      JSON.stringify(doc.metadata || {})
    ]);
    return result.lastInsertRowid;
  },

  async delete(id) {
    const docTranscripts = await allAsync('SELECT id FROM transcripts WHERE document_id = ?', [id]);
    for (const t of docTranscripts) {
      await runAsync('DELETE FROM annotations WHERE transcript_id = ?', [t.id]);
    }
    await runAsync('DELETE FROM transcripts WHERE document_id = ?', [id]);
    await runAsync('DELETE FROM document_collections WHERE document_id = ?', [id]);
    return await runAsync('DELETE FROM documents WHERE id = ?', [id]);
  }
};

const transcriptsAsync = {
  async getByDocumentId(documentId) {
    return await allAsync(`
      SELECT * FROM transcripts
      WHERE document_id = ?
      ORDER BY is_best DESC, version DESC
    `, [documentId]);
  },

  async getById(id) {
    return await getAsync('SELECT * FROM transcripts WHERE id = ?', [id]);
  },

  async getBestByDocumentId(documentId) {
    return await getAsync('SELECT * FROM transcripts WHERE document_id = ? AND is_best = 1', [documentId]);
  },

  async create(transcript) {
    const result = await runAsync(`
      INSERT INTO transcripts (
        document_id, content, transcriber, version, notes,
        provider, model, prompt, temperature, initiated_by, run_duration_ms,
        is_best, created_by_user_id, provider_key_scope, page_segments,
        input_tokens, output_tokens, cost_usd, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      transcript.document_id,
      transcript.content,
      transcript.transcriber,
      transcript.version || 1,
      transcript.notes,
      transcript.provider || null,
      transcript.model || null,
      transcript.prompt || null,
      transcript.temperature != null ? transcript.temperature : null,
      transcript.initiated_by || null,
      transcript.run_duration_ms || null,
      transcript.is_best ? 1 : 0,
      transcript.created_by_user_id || null,
      transcript.provider_key_scope || null,
      transcript.page_segments ? JSON.stringify(transcript.page_segments) : null,
      transcript.input_tokens != null ? transcript.input_tokens : null,
      transcript.output_tokens != null ? transcript.output_tokens : null,
      transcript.cost_usd != null ? transcript.cost_usd : null,
      transcript.confidence != null ? transcript.confidence : null
    ]);
    return result.lastInsertRowid;
  },

  async setBest(transcriptId, documentId) {
    await runAsync('UPDATE transcripts SET is_best = 0 WHERE document_id = ?', [documentId]);
    await runAsync('UPDATE transcripts SET is_best = 1 WHERE id = ? AND document_id = ?', [transcriptId, documentId]);
  },

  async updateContent(id, content) {
    await runAsync('UPDATE transcripts SET content = ? WHERE id = ?', [content, id]);
  },

  async updateContentAndPageSegments(id, content, pageSegments) {
    await runAsync('UPDATE transcripts SET content = ?, page_segments = ? WHERE id = ?', [
      content,
      pageSegments ? JSON.stringify(pageSegments) : null,
      id
    ]);
  },

  async updateNotes(id, notes) {
    await runAsync('UPDATE transcripts SET notes = ? WHERE id = ?', [notes, id]);
  },

  async delete(id) {
    await runAsync('DELETE FROM annotations WHERE transcript_id = ?', [id]);
    await runAsync('DELETE FROM transcripts WHERE id = ?', [id]);
  },

  async search(query, limit = 20, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    const searchTerms = query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter(term => term.length > 0);

    if (searchTerms.length === 0) return [];

    const termConditions = searchTerms.map(() =>
      '(t.content LIKE ? OR d.title LIKE ? OR d.description LIKE ?)'
    ).join(' OR ');

    const params = [];
    searchTerms.forEach(term => {
      const likeTerm = `%${term}%`;
      params.push(likeTerm, likeTerm, likeTerm);
    });

    let accessClause = '';
    if (!isAdmin && !accessAll && userId) {
      accessClause = `AND d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ?
      )`;
      params.push(userId);
    }

    params.push(limit);

    const results = await allAsync(`
      SELECT t.*, d.title as document_title, d.id as document_id, d.description as document_description
      FROM transcripts t
      JOIN documents d ON t.document_id = d.id
      WHERE t.is_best = 1 AND (${termConditions}) ${accessClause}
      ORDER BY t.created_at DESC
      LIMIT ?
    `, params);

    return results.map(row => {
      let snippet = '';
      for (const term of searchTerms) {
        const termLower = term.toLowerCase();
        if (row.document_title && row.document_title.toLowerCase().includes(termLower)) {
          snippet = row.content.substring(0, 200) + (row.content.length > 200 ? '...' : '');
          break;
        }
        if (row.document_description && row.document_description.toLowerCase().includes(termLower)) {
          snippet = row.document_description;
          break;
        }
        const idx = row.content.toLowerCase().indexOf(termLower);
        if (idx !== -1) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(row.content.length, idx + term.length + 80);
          snippet = (start > 0 ? '...' : '') + row.content.substring(start, end) + (end < row.content.length ? '...' : '');
          break;
        }
      }
      if (!snippet) snippet = row.content.substring(0, 200) + (row.content.length > 200 ? '...' : '');
      snippet = snippet
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      for (const term of searchTerms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escaped})`, 'gi');
        snippet = snippet.replace(regex, '<mark>$1</mark>');
      }
      return { ...row, snippet };
    });
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

  async set(key, value) {
    const storedValue = SECRET_SETTING_KEYS.has(key) && value != null && value !== ''
      ? encryptSecret(value)
      : value;
    await runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, storedValue]);
  },

  async hasSystemKeyForProvider(provider) {
    if (provider === 'openai') return !!((await this.get('openai_api_key')) || process.env.OPENAI_API_KEY);
    if (provider === 'claude') return !!((await this.get('anthropic_api_key')) || process.env.ANTHROPIC_API_KEY);
    if (provider === 'ollama' || provider === 'lmstudio') return true;
    return false;
  }
};

const userApiKeysAsync = {
  async getByUserId(userId) {
    return await allAsync(`
      SELECT id, user_id, provider, label, model, vision_model, utility_model,
             input_cost_per_mtok, output_cost_per_mtok, created_at, updated_at, last_used_at
      FROM user_api_keys
      WHERE user_id = ?
      ORDER BY provider, label, created_at
    `, [userId]);
  },

  async getByIdForUser(id, userId) {
    return await getAsync(`
      SELECT id, user_id, provider, label, encrypted_key, model, vision_model, utility_model,
             input_cost_per_mtok, output_cost_per_mtok, created_at, updated_at, last_used_at
      FROM user_api_keys
      WHERE id = ? AND user_id = ?
    `, [id, userId]);
  },

  async getResolvedForUser(id, userId) {
    const row = await this.getByIdForUser(id, userId);
    if (!row) return null;
    return {
      ...row,
      api_key: decryptSecret(row.encrypted_key),
      masked_key: maskSecret(decryptSecret(row.encrypted_key))
    };
  },

  async markUsed(id, userId) {
    await runAsync('UPDATE user_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [id, userId]);
  },

  async getProviderOptionsForUser(userId) {
    const keys = await this.getByUserId(userId);
    return keys.reduce((acc, key) => {
      if (!acc[key.provider]) acc[key.provider] = [];
      acc[key.provider].push({
        id: key.id,
        label: key.label,
        provider: key.provider,
        type: 'user'
      });
      return acc;
    }, {});
  },

  async create({ userId, provider, label, apiKey, model, visionModel, utilityModel, inputCostPerMtok, outputCostPerMtok }) {
    const result = await runAsync(`
      INSERT INTO user_api_keys (user_id, provider, label, encrypted_key, model, vision_model, utility_model, input_cost_per_mtok, output_cost_per_mtok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      provider,
      label,
      encryptSecret(apiKey),
      model || null,
      visionModel || null,
      utilityModel || null,
      inputCostPerMtok != null ? inputCostPerMtok : null,
      outputCostPerMtok != null ? outputCostPerMtok : null
    ]);
    return result.lastInsertRowid;
  },

  async updateVisionModel(id, userId, visionModel) {
    await runAsync(
      'UPDATE user_api_keys SET vision_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [visionModel || null, id, userId]
    );
  },

  async delete(id, userId) {
    await runAsync('DELETE FROM user_api_keys WHERE id = ? AND user_id = ?', [id, userId]);
  }
};

const annotationsAsync = {
  async getByTranscriptId(transcriptId) {
    return await allAsync(`
      SELECT * FROM annotations
      WHERE transcript_id = ?
      ORDER BY position_start, created_at
    `, [transcriptId]);
  },

  async getById(id) {
    return await getAsync('SELECT * FROM annotations WHERE id = ?', [id]);
  },

  async create(annotation) {
    const result = await runAsync(`
      INSERT INTO annotations (transcript_id, user_name, content, position_start, position_end)
      VALUES (?, ?, ?, ?, ?)
    `, [
      annotation.transcript_id,
      annotation.user_name,
      annotation.content,
      annotation.position_start,
      annotation.position_end
    ]);
    return result.lastInsertRowid;
  },

  async delete(id) {
    return await runAsync('DELETE FROM annotations WHERE id = ?', [id]);
  }
};

const documentCollectionsAsync = {
  async getByDocumentId(documentId) {
    return await allAsync(`
      SELECT c.* FROM collections c
      INNER JOIN document_collections dc ON c.id = dc.collection_id
      WHERE dc.document_id = ?
      ORDER BY c.name
    `, [documentId]);
  },

  async getByCollectionId(collectionId) {
    return await allAsync(`
      SELECT dc.document_id FROM document_collections dc
      WHERE dc.collection_id = ?
    `, [collectionId]);
  },

  async setForDocument(documentId, collectionIds) {
    await runAsync('DELETE FROM document_collections WHERE document_id = ?', [documentId]);
    for (const cid of (collectionIds || [])) {
      try {
        await runAsync('INSERT OR IGNORE INTO document_collections (document_id, collection_id) VALUES (?, ?)', [documentId, cid]);
      } catch (e) {}
    }
  },

  async add(documentId, collectionId) {
    await runAsync('INSERT OR IGNORE INTO document_collections (document_id, collection_id) VALUES (?, ?)', [documentId, collectionId]);
  },

  async remove(documentId, collectionId) {
    await runAsync('DELETE FROM document_collections WHERE document_id = ? AND collection_id = ?', [documentId, collectionId]);
  }
};

const ROLE_HIERARCHY = { viewer: 1, editor: 2, manager: 3 };
function roleAtLeast(userRole, minRole) {
  return (ROLE_HIERARCHY[userRole] || 0) >= (ROLE_HIERARCHY[minRole] || 0);
}

const userCollectionAccessAsync = {
  async getIdsByUserId(userId) {
    const rows = await allAsync('SELECT collection_id FROM user_collection_access WHERE user_id = ?', [userId]);
    return rows.map(r => r.collection_id);
  },

  async getWithRolesByUserId(userId) {
    return await allAsync('SELECT collection_id, role FROM user_collection_access WHERE user_id = ?', [userId]);
  },

  async getRoleForUser(userId, collectionId) {
    const row = await getAsync('SELECT role FROM user_collection_access WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
    return row ? row.role : null;
  },

  async getByCollectionId(collectionId) {
    return await allAsync(`
      SELECT u.id, u.username, u.email, u.role AS system_role, uca.role AS collection_role
      FROM users u
      INNER JOIN user_collection_access uca ON u.id = uca.user_id
      WHERE uca.collection_id = ?
      ORDER BY u.username
    `, [collectionId]);
  },

  async setForUser(userId, collectionIds) {
    await runAsync('DELETE FROM user_collection_access WHERE user_id = ?', [userId]);
    for (const cid of (collectionIds || [])) {
      try {
        await runAsync('INSERT OR IGNORE INTO user_collection_access (user_id, collection_id, role) VALUES (?, ?, ?)', [userId, cid, 'viewer']);
      } catch (e) {}
    }
  },

  async setForUserWithRoles(userId, collectionRoles) {
    await runAsync('DELETE FROM user_collection_access WHERE user_id = ?', [userId]);
    for (const [cid, role] of Object.entries(collectionRoles || {})) {
      const safeRole = ROLE_HIERARCHY[role] ? role : 'viewer';
      try {
        await runAsync('INSERT OR IGNORE INTO user_collection_access (user_id, collection_id, role) VALUES (?, ?, ?)', [userId, parseInt(cid), safeRole]);
      } catch (e) {}
    }
  },

  async grant(userId, collectionId, role) {
    const safeRole = ROLE_HIERARCHY[role] ? role : 'viewer';
    try {
      const existing = await getAsync('SELECT role FROM user_collection_access WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
      if (existing) {
        await runAsync('UPDATE user_collection_access SET role = ? WHERE user_id = ? AND collection_id = ?', [safeRole, userId, collectionId]);
      } else {
        await runAsync('INSERT INTO user_collection_access (user_id, collection_id, role) VALUES (?, ?, ?)', [userId, collectionId, safeRole]);
      }
    } catch (e) {}
  },

  async revoke(userId, collectionId) {
    await runAsync('DELETE FROM user_collection_access WHERE user_id = ? AND collection_id = ?', [userId, collectionId]);
  },

  async getManagerCollectionIds(userId) {
    const rows = await allAsync("SELECT collection_id FROM user_collection_access WHERE user_id = ? AND role = 'manager'", [userId]);
    return rows.map(r => r.collection_id);
  },

  async getEditableCollectionIds(userId) {
    const rows = await allAsync("SELECT collection_id FROM user_collection_access WHERE user_id = ? AND role IN ('editor', 'manager')", [userId]);
    return rows.map(r => r.collection_id);
  },

  async getManagerCollectionIdForDocument(userId, documentId) {
    const row = await getAsync(`
      SELECT uca.collection_id FROM user_collection_access uca
      INNER JOIN document_collections dc ON dc.collection_id = uca.collection_id
      WHERE uca.user_id = ? AND dc.document_id = ? AND uca.role = 'manager'
      LIMIT 1
    `, [userId, documentId]);
    return row ? row.collection_id : null;
  },

  async hasRoleOnDocumentCollections(userId, documentId, minRole) {
    const row = await getAsync(`
      SELECT uca.role FROM user_collection_access uca
      INNER JOIN document_collections dc ON dc.collection_id = uca.collection_id
      WHERE uca.user_id = ? AND dc.document_id = ?
      ORDER BY CASE uca.role WHEN 'manager' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END DESC
      LIMIT 1
    `, [userId, documentId]);
    return row ? roleAtLeast(row.role, minRole) : false;
  }
};

const collectionsAsync = {
  async getAll() {
    return await allAsync(`
      SELECT c.*,
             (SELECT COUNT(*) FROM document_collections WHERE collection_id = c.id) as document_count
      FROM collections c
      ORDER BY c.name
    `);
  },

  async getAllWithThumbnails() {
    return await allAsync(`
      SELECT c.*,
             (SELECT COUNT(*) FROM document_collections WHERE collection_id = c.id) as document_count,
             COALESCE(
               (SELECT d.image_path FROM documents d WHERE d.id = c.preview_document_id),
               (SELECT d.image_path FROM documents d
                INNER JOIN document_collections dc ON d.id = dc.document_id
                WHERE dc.collection_id = c.id
                ORDER BY d.created_at DESC LIMIT 1)
             ) as thumbnail
      FROM collections c
      ORDER BY c.name
    `);
  },

  async getById(id) {
    return await getAsync('SELECT * FROM collections WHERE id = ?', [id]);
  },

  async canAccess(collectionId, userId, isAdmin, accessAll) {
    if (isAdmin || accessAll) return true;

    if (!userId) {
      // Unauthenticated: world-public only
      const result = await getAsync(`SELECT id FROM collections WHERE id = ? AND is_world_public = 1`, [collectionId]);
      return !!result;
    }

    const result = await getAsync(`
      SELECT c.id
      FROM collections c
      LEFT JOIN user_collection_access uca
        ON c.id = uca.collection_id AND uca.user_id = ?
      WHERE c.id = ?
        AND (c.is_public = 1 OR uca.user_id IS NOT NULL)
    `, [userId, collectionId]);

    return !!result;
  },

  async create({ name, description, is_public, is_world_public, allow_export, auto_group_pages, createdBy }) {
    const result = await runAsync(
      'INSERT INTO collections (name, description, is_public, is_world_public, allow_export, auto_group_pages, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, description || null, is_public ? 1 : 0, is_world_public ? 1 : 0, allow_export ? 1 : 0, auto_group_pages ? 1 : 0, createdBy || null]
    );
    return result.lastInsertRowid;
  },

  async update(id, { name, description, is_public, is_world_public }) {
    await runAsync('UPDATE collections SET name = ?, description = ?, is_public = ?, is_world_public = ? WHERE id = ?',
      [name, description || null, is_public ? 1 : 0, is_world_public ? 1 : 0, id]);
  },

  async setPreviewDocument(id, documentId) {
    if (documentId != null) {
      const belongsToCollection = await getAsync(`
        SELECT 1
        FROM document_collections
        WHERE collection_id = ? AND document_id = ?
      `, [id, documentId]);
      if (!belongsToCollection) {
        throw new Error('Preview document must belong to the collection');
      }
    }
    await runAsync('UPDATE collections SET preview_document_id = ? WHERE id = ?',
      [documentId || null, id]);
  },

  async setAllowExport(id, allow) {
    await runAsync('UPDATE collections SET allow_export = ? WHERE id = ?', [allow ? 1 : 0, id]);
  },

  async setAutoGroupPages(id, enabled) {
    await runAsync('UPDATE collections SET auto_group_pages = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  },

  async delete(id) {
    return await runAsync('DELETE FROM collections WHERE id = ?', [id]);
  }
};

const usersAsync = {
  async count() {
    const result = await getAsync('SELECT COUNT(*) as n FROM users');
    return result ? result.n : 0;
  },

  async findById(id) {
    return await getAsync('SELECT * FROM users WHERE id = ?', [id]);
  },

  async findByUsername(username) {
    return await getAsync('SELECT * FROM users WHERE username = ?', [username]);
  },

  async findByEmail(email) {
    return await getAsync('SELECT * FROM users WHERE email = ?', [email]);
  },

  async getAll() {
    return await allAsync(`
      SELECT
        id, username, email, role, status, access_all, can_use_system_api_keys,
        mfa_method, created_at
      FROM users
      ORDER BY created_at
    `);
  },

  async getPending() {
    return await allAsync("SELECT id, username, email, created_at FROM users WHERE status = 'pending' ORDER BY created_at");
  },

  async create({ username, email, passwordHash, role, status, accessAll, canUseSystemApiKeys, inviteId }) {
    const result = await runAsync(
      `INSERT INTO users
        (username, email, password_hash, role, status, access_all, can_use_system_api_keys, invite_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        email || null,
        passwordHash,
        role || 'user',
        status || 'pending',
        accessAll ? 1 : 0,
        canUseSystemApiKeys ? 1 : 0,
        inviteId || null
      ]
    );
    return result.lastInsertRowid;
  },

  async updatePassword(id, passwordHash) {
    await runAsync('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  },

  async updatePasswordChangedAt(id) {
    await runAsync('UPDATE users SET password_changed_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  async approve(id, { role, accessAll, canUseSystemApiKeys }) {
    await runAsync(
      "UPDATE users SET status = 'active', role = ?, access_all = ?, can_use_system_api_keys = ? WHERE id = ?",
      [role || 'user', accessAll ? 1 : 0, canUseSystemApiKeys ? 1 : 0, id]
    );
  },

  async reject(id) {
    await runAsync("UPDATE users SET status = 'rejected' WHERE id = ?", [id]);
  },

  async setRole(id, role) {
    await runAsync('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  },

  async setAccessAll(id, accessAll) {
    await runAsync('UPDATE users SET access_all = ? WHERE id = ?', [accessAll ? 1 : 0, id]);
  },

  async setCanUseSystemApiKeys(id, enabled) {
    await runAsync('UPDATE users SET can_use_system_api_keys = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  },

  async updateEmail(id, email) {
    await runAsync('UPDATE users SET email = ? WHERE id = ?', [email || null, id]);
  },

  async updateProfile(id, { username, email }) {
    if (username !== undefined) {
      await runAsync('UPDATE users SET username = ? WHERE id = ?', [username, id]);
    }
    if (email !== undefined) {
      await runAsync('UPDATE users SET email = ? WHERE id = ?', [email || null, id]);
    }
  },

  async setMfaMethod(id, method) {
    await runAsync('UPDATE users SET mfa_method = ? WHERE id = ?', [method || 'none', id]);
  },

  async setTotpSecret(id, secret) {
    const storedSecret = secret ? encryptSecret(secret) : null;
    await runAsync('UPDATE users SET mfa_totp_secret = ? WHERE id = ?', [storedSecret, id]);
  },

  async getTotpSecret(id) {
    const row = await getAsync('SELECT mfa_totp_secret FROM users WHERE id = ?', [id]);
    return row?.mfa_totp_secret ? decryptSecret(row.mfa_totp_secret) : null;
  },

  async storeEmailOtp(id, code, expiresAt) {
    await runAsync(
      'UPDATE users SET mfa_email_otp_hash = ?, mfa_email_otp_expires_at = ?, mfa_email_otp_sent_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hashOtpCode(code), expiresAt, id]
    );
  },

  async clearEmailOtp(id) {
    await runAsync(
      'UPDATE users SET mfa_email_otp_hash = NULL, mfa_email_otp_expires_at = NULL, mfa_email_otp_sent_at = NULL WHERE id = ?',
      [id]
    );
  },

  async verifyEmailOtp(id, code) {
    const row = await getAsync('SELECT mfa_email_otp_hash, mfa_email_otp_expires_at FROM users WHERE id = ?', [id]);
    if (!row?.mfa_email_otp_hash || !row?.mfa_email_otp_expires_at) return false;
    if (new Date(row.mfa_email_otp_expires_at).getTime() < Date.now()) return false;
    const stored = Buffer.from(row.mfa_email_otp_hash);
    const computed = Buffer.from(hashOtpCode(code));
    return stored.length === computed.length && crypto.timingSafeEqual(stored, computed);
  },

  async delete(id) {
    // Nullify references in tables without ON DELETE CASCADE
    await runAsync('UPDATE collections SET created_by = NULL WHERE created_by = ?', [id]);
    await runAsync('UPDATE user_invites SET invited_by = NULL WHERE invited_by = ?', [id]);
    await runAsync('UPDATE user_invites SET accepted_by_user_id = NULL WHERE accepted_by_user_id = ?', [id]);
    await runAsync('UPDATE password_reset_tokens SET created_by = NULL WHERE created_by = ?', [id]);
    // Tables with ON DELETE CASCADE (user_collection_access, user_api_keys, password_reset_tokens.user_id)
    // are handled automatically by SQLite
    return await runAsync('DELETE FROM users WHERE id = ?', [id]);
  }
};

const userInvitesAsync = {
  async create({ email, tokenHash, role, accessAll, canUseSystemApiKeys, collectionIds, collectionRoles, invitedBy, expiresAt }) {
    const result = await runAsync(`
      INSERT INTO user_invites
        (email, token_hash, role, access_all, can_use_system_api_keys, collection_ids, collection_roles, invited_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      email,
      tokenHash,
      role || 'user',
      accessAll ? 1 : 0,
      canUseSystemApiKeys ? 1 : 0,
      JSON.stringify(normalizeCollectionIds(collectionIds)),
      collectionRoles ? JSON.stringify(collectionRoles) : null,
      invitedBy || null,
      expiresAt
    ]);
    return result.lastInsertRowid;
  },

  async getActive() {
    const rows = await allAsync(`
      SELECT i.*, u.username AS invited_by_username
      FROM user_invites i
      LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND datetime(i.expires_at) > datetime('now')
      ORDER BY i.created_at DESC
    `);
    return rows.map(invite => ({
      ...invite,
      collection_ids: parseInviteCollectionIds(invite.collection_ids)
    }));
  },

  async findByTokenHash(tokenHash) {
    const invite = await getAsync('SELECT * FROM user_invites WHERE token_hash = ?', [tokenHash]);
    return invite ? { ...invite, collection_ids: parseInviteCollectionIds(invite.collection_ids) } : null;
  },

  async markAccepted(id, userId) {
    await runAsync(
      'UPDATE user_invites SET accepted_at = CURRENT_TIMESTAMP, accepted_by_user_id = ? WHERE id = ?',
      [userId, id]
    );
  },

  async revoke(id) {
    await runAsync('UPDATE user_invites SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }
};

const passwordResetTokensAsync = {
  async create({ userId, tokenHash, createdBy, expiresAt }) {
    await runAsync(
      `UPDATE password_reset_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND datetime(expires_at) > datetime('now')`,
      [userId]
    );

    const result = await runAsync(`
      INSERT INTO password_reset_tokens (user_id, token_hash, created_by, expires_at)
      VALUES (?, ?, ?, ?)
    `, [userId, tokenHash, createdBy || null, expiresAt]);
    return result.lastInsertRowid;
  },

  async findByTokenHash(tokenHash) {
    return await getAsync(`
      SELECT prt.*, u.username, u.email
      FROM password_reset_tokens prt
      INNER JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = ?
    `, [tokenHash]);
  },

  async markUsed(id) {
    await runAsync('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  },

  async revokeForUser(userId) {
    await runAsync(
      `UPDATE password_reset_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      [userId]
    );
  }
};

// ── MFA Remember Tokens ──────────────────────────────────────────────────

const mfaRememberTokensAsync = {
  async create(userId, tokenHash, expiresAt) {
    await runAsync(
      `INSERT INTO mfa_remember_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [userId, tokenHash, expiresAt]
    );
  },

  async verify(userId, tokenHash) {
    const row = await getAsync(
      `SELECT id FROM mfa_remember_tokens WHERE user_id = ? AND token_hash = ? AND expires_at > datetime('now')`,
      [userId, tokenHash]
    );
    return !!row;
  },

  async deleteForUser(userId) {
    await runAsync(`DELETE FROM mfa_remember_tokens WHERE user_id = ?`, [userId]);
  },

  async deleteExpired() {
    await runAsync(`DELETE FROM mfa_remember_tokens WHERE expires_at <= datetime('now')`);
  }
};

// ── Document Events (audit log) ────────────────────────────────────────────
const documentEventsAsync = {
  async log(documentId, userId, userName, eventType, details = null) {
    await runAsync(`
      INSERT INTO document_events (document_id, user_id, user_name, event_type, details)
      VALUES (?, ?, ?, ?, ?)
    `, [documentId, userId || null, userName || null, eventType, details ? JSON.stringify(details) : null]);
  },

  async getByDocumentId(documentId, limit = 50, offset = 0) {
    return await allAsync(`
      SELECT * FROM document_events
      WHERE document_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [documentId, limit, offset]);
  },

  async getCountByDocumentId(documentId) {
    const row = await getAsync('SELECT COUNT(*) as count FROM document_events WHERE document_id = ?', [documentId]);
    return row ? row.count : 0;
  }
};

function getDb() { return db; }

module.exports = {
  initDatabase,
  initializeSchema,
  saveDatabase,
  getDb,
  documents,
  transcripts,
  annotations,
  users,
  usersAsync,
  userInvites,
  userInvitesAsync,
  userApiKeys,
  passwordResetTokens,
  passwordResetTokensAsync,
  collections,
  documentCollections,
  userCollectionAccess,
  settings,
  settingsAsync,
  transcriptionJobs,
  transcriptionJobsAsync,
  importJobs,
  importJobsAsync,
  adminJobsAsync,
  documentsAsync,
  transcriptsAsync,
  annotationsAsync,
  documentCollectionsAsync,
  userCollectionAccessAsync,
  collectionsAsync,
  userApiKeysAsync,
  mfaRememberTokensAsync,
  documentEventsAsync,
  roleAtLeast
};
