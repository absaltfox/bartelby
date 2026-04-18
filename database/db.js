const {
  canEncryptSecrets,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret
} = require('../utils/secrets');
const crypto = require('crypto');
const { hashOtpCode } = require('../utils/mfa');
const { initDriver } = require('./driver');
const {
  CITATION_APPROVAL_STATUSES,
  deriveCitationApproval
} = require('../utils/knowledge-approval');

let db = null;


const USER_SECRET_PROVIDERS = new Set(['openai', 'claude']);

// ── Migrations ──────────────────────────────────────────────────────────────
// Each entry is applied exactly once, tracked via PRAGMA user_version in the
// DB file itself. To add a new migration, append to this array — never edit
// existing entries. schema.sql is kept as a human-readable reference only.

const { MIGRATIONS, FTS_TRIGGERS } = require('./migrations');


// v46 — reset-aware extraction reruns
MIGRATIONS.push(`
  ALTER TABLE extraction_jobs ADD COLUMN reset_existing INTEGER NOT NULL DEFAULT 0
`);

MIGRATIONS.push(`
  ALTER TABLE extraction_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'single';
  ALTER TABLE extraction_jobs ADD COLUMN batch_display_name TEXT;
  ALTER TABLE extraction_jobs ADD COLUMN batch_document_count INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE extraction_jobs ADD COLUMN batch_completed_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE extraction_jobs ADD COLUMN batch_failed_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE extraction_jobs ADD COLUMN batch_remote_id TEXT;
  ALTER TABLE extraction_jobs ADD COLUMN batch_remote_status TEXT;
  ALTER TABLE extraction_jobs ADD COLUMN batch_manifest TEXT;
  CREATE TABLE IF NOT EXISTS extraction_job_documents (
    job_id INTEGER NOT NULL REFERENCES extraction_jobs(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    PRIMARY KEY (job_id, document_id, transcript_id)
  );
  CREATE INDEX IF NOT EXISTS idx_extraction_job_documents_document_id
    ON extraction_job_documents(document_id);
  CREATE INDEX IF NOT EXISTS idx_extraction_job_documents_job_id
    ON extraction_job_documents(job_id);
`);

// v48 — explicit citation approval workflow for knowledge graph visibility
MIGRATIONS.push(`
  ALTER TABLE citations ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE citations ADD COLUMN approval_method TEXT;
  ALTER TABLE citations ADD COLUMN approved_at DATETIME;
  ALTER TABLE citations ADD COLUMN approved_by_user_id INTEGER;
  ALTER TABLE citations ADD COLUMN rejected_at DATETIME;
  ALTER TABLE citations ADD COLUMN rejected_by_user_id INTEGER;
  UPDATE citations
  SET approval_status = CASE
        WHEN reviewed_at IS NOT NULL THEN 'approved'
        WHEN COALESCE(confidence, 0) >= 0.85 THEN 'approved'
        ELSE 'pending'
      END,
      approval_method = CASE
        WHEN reviewed_at IS NOT NULL THEN 'manual'
        WHEN COALESCE(confidence, 0) >= 0.85 THEN 'auto'
        ELSE NULL
      END,
      approved_at = CASE
        WHEN reviewed_at IS NOT NULL THEN reviewed_at
        WHEN COALESCE(confidence, 0) >= 0.85 THEN CURRENT_TIMESTAMP
        ELSE NULL
      END,
      approved_by_user_id = CASE
        WHEN reviewed_at IS NOT NULL THEN reviewed_by_user_id
        ELSE NULL
      END
  WHERE approval_status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_citations_approval_status ON citations(approval_status);
`);

// v49 — structured application logs and logging settings
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS app_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    context_json TEXT,
    request_id TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    job_type TEXT,
    job_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_app_logs_created_at ON app_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);
  CREATE INDEX IF NOT EXISTS idx_app_logs_category ON app_logs(category);
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('log_level', 'info'),
    ('log_persist_enabled', '1'),
    ('log_persist_min_level', 'warn'),
    ('log_slow_request_ms', '1000'),
    ('log_event_loop_monitor_enabled', '0'),
    ('log_event_loop_lag_warn_ms', '250'),
    ('log_retention_days', '14');
`);

// v50 — analytics schedule day/time settings
MIGRATIONS.push(`
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('analytics_schedule_day_of_week', '1'),
    ('analytics_schedule_time', '02:00');
`);

// v51 — composite citation indexes (always safe) plus FTS5 virtual tables
// (only available on libSQL/Turso; sql.js may not include the fts5 module).
// FTS5 table creation and triggers are attempted separately in ensureFts5()
// so that environments without FTS5 still complete the migration.
MIGRATIONS.push(`
  CREATE INDEX IF NOT EXISTS idx_citations_entity_approval ON citations(entity_id, approval_status);
  CREATE INDEX IF NOT EXISTS idx_citations_relationship_approval ON citations(relationship_id, approval_status);
  CREATE INDEX IF NOT EXISTS idx_citations_document_approval ON citations(document_id, approval_status);
`);

// v52 — heartbeat tracking for import jobs on ephemeral Fly machines
MIGRATIONS.push(`
  ALTER TABLE import_jobs ADD COLUMN last_heartbeat_at DATETIME
`);

// v53 — checkpoint partial page results for extraction batch retries
MIGRATIONS.push(`
  ALTER TABLE extraction_jobs ADD COLUMN partial_results TEXT
`);

// FTS5 sync triggers — run as whole statements outside the semicolon-splitting
// migration runner. Each trigger contains internal semicolons inside BEGIN…END
// that would be incorrectly split by the migration loop. These are idempotent
// (IF NOT EXISTS) so safe to run on every startup.


let fts5Available = false;

async function ensureFts5() {
  // Attempt to create FTS5 virtual tables. This will fail silently on SQLite
  // builds that lack the fts5 module (e.g. the default sql.js package used in
  // local dev and tests). Search functions fall back to LIKE when FTS5 is absent.
  const FTS_TABLES = [
    `CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(canonical_name, content=entities, content_rowid=id)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS entity_aliases_fts USING fts5(alias, content=entity_aliases, content_rowid=id)`
  ];

  for (const sql of FTS_TABLES) {
    try {
      await db.run(sql);
    } catch (e) {
      if (e.message.includes('no such module: fts5')) {
        console.log('[db] FTS5 not available in this SQLite build — entity search will use LIKE fallback.');
        return; // skip triggers and rebuild too
      }
      if (!e.message.includes('already exists')) {
        console.error('[db] FTS5 table creation failed:', e.message);
        return;
      }
    }
  }

  // Rebuild FTS indexes from current data (idempotent, fast on small tables)
  try {
    await db.run(`INSERT INTO entities_fts(entities_fts) VALUES('rebuild')`);
    await db.run(`INSERT INTO entity_aliases_fts(entity_aliases_fts) VALUES('rebuild')`);
  } catch (e) {
    console.error('[db] FTS5 rebuild failed:', e.message);
    return;
  }

  // Create sync triggers so FTS stays in sync with base tables
  for (const sql of FTS_TRIGGERS) {
    try {
      await db.run(sql);
    } catch (e) {
      if (!e.message.includes('already exists')) {
        console.error('[db] FTS trigger creation failed:', e.message);
      }
    }
  }

  fts5Available = true;
  console.log('[db] FTS5 entity search indexes ready.');
}

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
  if (db.persistent === false) return Promise.resolve();
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

/**
 * Flush the database to disk immediately, bypassing the debounce timer.
 *
 * Use this ONLY during graceful shutdown (SIGTERM / SIGINT), where the normal
 * 300 ms debounce would create a window between process.exit() and the actual
 * persist call.  For all other write paths, use saveDatabase() so bursts are
 * collapsed into a single write.
 *
 * Cancels any pending debounce timer and resolves any callers currently
 * awaiting saveDatabase() to avoid dangling promises.
 */
async function flushDatabase() {
  if (!db) return;
  if (db.persistent === false) return;
  // Cancel the pending debounce so it doesn't fire after we flush.
  clearTimeout(_saveTimer);
  _saveTimer = null;
  // Resolve any pending saveDatabase() waiters before we flush.
  const resolve = _saveResolve;
  _savePending = null;
  _saveResolve = null;
  _saveReject = null;
  try {
    await db.persist();
    if (resolve) resolve();
  } catch (e) {
    console.error('[db] flushDatabase failed:', e.message);
    if (resolve) resolve(); // don't leave waiters hanging
  }
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

  // Attempt to set up FTS5 virtual tables and sync triggers (idempotent).
  // Skipped silently on SQLite builds without fts5 (e.g. default sql.js).
  await ensureFts5();

  // Recover from unclean shutdown: any jobs left in processing/running
  // can never complete (the process that was handling them is gone).
  // Skip jobs with a machine_id — they run on ephemeral Fly machines
  // and may still be processing on a separate VM.
  const staleRenderImports = await get(`
    SELECT COUNT(*) as count
    FROM import_jobs
    WHERE status = 'processing'
      AND machine_id IS NULL
      AND COALESCE(job_kind, 'render') = 'render'
  `);
  const staleRenderImportCount = staleRenderImports?.count || 0;
  if (staleRenderImportCount > 0) {
    await db.run(`
      UPDATE import_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'processing'
        AND machine_id IS NULL
        AND COALESCE(job_kind, 'render') = 'render'
    `);
    console.log(`[db] Marked ${staleRenderImportCount} stale render import job(s) as failed`);
  }

  const staleSubmitImports = await get(`
    SELECT COUNT(*) as count
    FROM import_jobs
    WHERE status = 'running'
      AND COALESCE(job_kind, 'render') = 'submit'
  `);
  const staleSubmitImportCount = staleSubmitImports?.count || 0;
  if (staleSubmitImportCount > 0) {
    await db.run(`
      UPDATE import_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL
      WHERE status = 'running'
        AND COALESCE(job_kind, 'render') = 'submit'
    `);
    console.log(`[db] Requeued ${staleSubmitImportCount} stale import submission job(s)`);
  }

  const staleGroupingImports = await get(`
    SELECT COUNT(*) as count
    FROM import_jobs
    WHERE status = 'processing'
      AND COALESCE(job_kind, 'render') = 'grouping'
  `);
  const staleGroupingImportCount = staleGroupingImports?.count || 0;
  if (staleGroupingImportCount > 0) {
    await db.run(`
      UPDATE import_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL
      WHERE status = 'processing'
        AND COALESCE(job_kind, 'render') = 'grouping'
    `);
    console.log(`[db] Requeued ${staleGroupingImportCount} stale grouping job(s)`);
  }

  const staleTranscriptions = await get(`
    SELECT COUNT(*) as count
    FROM transcription_jobs
    WHERE status = 'running'
      AND (job_kind IS NULL OR job_kind != 'batch' OR batch_remote_id IS NULL)
  `);
  const staleTranscriptionCount = staleTranscriptions?.count || 0;
  if (staleTranscriptionCount > 0) {
    await db.run(`
      UPDATE transcription_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND (job_kind IS NULL OR job_kind != 'batch' OR batch_remote_id IS NULL)
    `);
    console.log(`[db] Marked ${staleTranscriptionCount} stale transcription job(s) as failed`);
  }

  // Transcription batch jobs whose remote provider already returned results
  // but were never marked done (transient finalization error).
  // Terminal status varies by provider: Anthropic='ended', OpenAI='completed'.
  const staleCompletedTxBatches = await get(`
    SELECT COUNT(*) as count
    FROM transcription_jobs
    WHERE status = 'running'
      AND job_kind = 'batch'
      AND batch_remote_id IS NOT NULL
      AND (batch_remote_status IN ('ended', 'completed', 'JOB_STATE_SUCCEEDED')
             OR batch_remote_status LIKE 'completed (%')
  `);
  const staleCompletedTxBatchCount = staleCompletedTxBatches?.count || 0;
  if (staleCompletedTxBatchCount > 0) {
    await db.run(`
      UPDATE transcription_jobs
      SET status = 'done',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND job_kind = 'batch'
        AND batch_remote_id IS NOT NULL
        AND (batch_remote_status IN ('ended', 'completed', 'JOB_STATE_SUCCEEDED')
             OR batch_remote_status LIKE 'completed (%')
    `);
    console.log(`[db] Marked ${staleCompletedTxBatchCount} already-completed transcription batch job(s) as done`);
  }

  const staleExtractions = await getAsync(`
    SELECT COUNT(*) as count
    FROM extraction_jobs
    WHERE status = 'running'
      AND (job_kind IS NULL OR job_kind != 'batch' OR batch_remote_id IS NULL)
  `);
  const staleExtractionCount = staleExtractions?.count || 0;
  if (staleExtractionCount > 0) {
    await db.run(`
      UPDATE extraction_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND (job_kind IS NULL OR job_kind != 'batch' OR batch_remote_id IS NULL)
    `);
    console.log(`[db] Marked ${staleExtractionCount} stale extraction job(s) as failed`);
  }

  // Extraction batch jobs whose remote provider already returned results
  // but were never marked done — typically caused by a transient error
  // during finalization.  Mark them done to prevent re-finalization
  // (which would duplicate entities).
  // Terminal status varies by provider: Anthropic='ended', OpenAI='completed'.
  const staleCompletedBatches = await getAsync(`
    SELECT COUNT(*) as count
    FROM extraction_jobs
    WHERE status = 'running'
      AND job_kind = 'batch'
      AND batch_remote_id IS NOT NULL
      AND (batch_remote_status IN ('ended', 'completed', 'JOB_STATE_SUCCEEDED')
             OR batch_remote_status LIKE 'completed (%')
  `);
  const staleCompletedBatchCount = staleCompletedBatches?.count || 0;
  if (staleCompletedBatchCount > 0) {
    await db.run(`
      UPDATE extraction_jobs
      SET status = 'done',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND job_kind = 'batch'
        AND batch_remote_id IS NOT NULL
        AND (batch_remote_status IN ('ended', 'completed', 'JOB_STATE_SUCCEEDED')
             OR batch_remote_status LIKE 'completed (%')
    `);
    console.log(`[db] Marked ${staleCompletedBatchCount} already-completed extraction batch job(s) as done`);
  }

  if (staleRenderImportCount > 0 || staleSubmitImportCount > 0 || staleTranscriptionCount > 0 || staleExtractionCount > 0 || staleCompletedTxBatchCount > 0 || staleCompletedBatchCount > 0) {
    await saveDatabase();
  }

  // Recover stale Fly machine import jobs (heartbeat-based)
  const thresholdMs = parseInt(process.env.WORKER_HEARTBEAT_TIMEOUT_MS, 10) || 300000;
  const thresholdSeconds = Math.floor(thresholdMs / 1000);
  const staleHeartbeatImports = await get(`
    SELECT COUNT(*) as count
    FROM import_jobs
    WHERE status = 'processing'
      AND machine_id IS NOT NULL
      AND last_heartbeat_at IS NOT NULL
      AND last_heartbeat_at < datetime('now', '-${thresholdSeconds} seconds')
  `);
  const staleHeartbeatCount = staleHeartbeatImports?.count || 0;
  if (staleHeartbeatCount > 0) {
    await db.run(`
      UPDATE import_jobs
      SET status = 'queued',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          last_heartbeat_at = NULL,
          machine_id = NULL
      WHERE status = 'processing'
        AND machine_id IS NOT NULL
        AND last_heartbeat_at IS NOT NULL
        AND last_heartbeat_at < datetime('now', '-${thresholdSeconds} seconds')
    `);
    console.log(`[db] Requeued ${staleHeartbeatCount} stale Fly import job(s) via heartbeat timeout`);
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
// ── Transcription Jobs ──────────────────────────────────────────────────────




// ── Import Jobs (background PDF processing) ─────────────────────────────




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

function runWithoutSave(sql, params = []) {
  return db.run(sql, params);
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

async function runAsyncWithoutSave(sql, params = []) {
  return await db.run(sql, params);
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

// ── Documents ──────────────────────────────────────────────────────────────




// ── Transcripts ────────────────────────────────────────────────────────────




// ── Annotations ────────────────────────────────────────────────────────────




// ── Users ──────────────────────────────────────────────────────────────────













// ── Collections ────────────────────────────────────────────────────────────




// ── Document-Collections junction ──────────────────────────────────────────




// ── User-Collection access ──────────────────────────────────────────────────




// ── Settings ───────────────────────────────────────────────────────────────










// Combined admin jobs helpers (paginated UNION across both job tables)



























function parseJsonValue(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}


























































// ── MFA Remember Tokens ──────────────────────────────────────────────────




// ── Document Events (audit log) ────────────────────────────────────────────



// ── Application Logs ───────────────────────────────────────────────────────





// --- Model Loaders ---
const { users, userInvites, userApiKeys, passwordResetTokens, usersAsync, userInvitesAsync, userApiKeysAsync, passwordResetTokensAsync, mfaRememberTokensAsync, maskSecret, ROLE_HIERARCHY, roleAtLeast } = require('./models/users')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);
const { documents, documentsAsync, transcripts, transcriptsAsync, annotations, annotationsAsync, documentEventsAsync } = require('./models/documents')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);
const { collections, collectionsAsync, documentCollections, documentCollectionsAsync, userCollectionAccess, userCollectionAccessAsync, normalizeCollectionIds, parseInviteCollectionIds } = require('./models/collections')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);
const { transcriptionJobs, transcriptionJobsAsync, importJobs, importJobsAsync, adminJobsAsync, extractionJobs } = require('./models/jobs')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all, runWithoutSave, runAsyncWithoutSave);
const { entities, entityAliases, dateExpressions, relationships, citations, graphMaintenance, relationshipTypes, graphAccess, hydrateEntity, hydrateRelationship, buildAccessibleDocumentFilter, buildCollectionDocumentFilter, buildKnowledgeCitationVisibilityFilter, buildCitationQueryConditions } = require('./models/knowledge-graph')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all, () => fts5Available);
const { collectionAnalyticsAsync, documentEmbeddingsAsync, collectionTopicsAsync, documentTopicAssignmentsAsync, topicEvolutionAsync, topicHierarchyAsync } = require('./models/analytics')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);
const { SECRET_SETTING_KEYS, settings, settingsAsync } = require('./models/settings')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);
const { appLogsAsync } = require('./models/logs')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);

function getDb() { return db; }

module.exports = {
  initDatabase,
  initializeSchema,
  saveDatabase,
  flushDatabase,
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
  appLogsAsync,
  roleAtLeast,
  collectionAnalyticsAsync,
  documentEmbeddingsAsync,
  collectionTopicsAsync,
  documentTopicAssignmentsAsync,
  topicEvolutionAsync,
  topicHierarchyAsync,
  entities,
  entitiesAsync: entities,
  entityAliases,
  entityAliasesAsync: entityAliases,
  dateExpressions,
  dateExpressionsAsync: dateExpressions,
  relationships,
  relationshipsAsync: relationships,
  citations,
  citationsAsync: citations,
  graphMaintenance,
  graphMaintenanceAsync: graphMaintenance,
  extractionJobs,
  extractionJobsAsync: extractionJobs,
  relationshipTypes,
  relationshipTypesAsync: relationshipTypes,
  graphAccess,
  graphAccessAsync: graphAccess
};
