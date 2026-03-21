const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data', 'transcriber.db');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

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
    ('lmstudio_model', 'local-model')
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
];

// ── Core database setup ─────────────────────────────────────────────────────

async function initDatabase() {
  if (db) return db;

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  return db;
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }
}

async function initializeSchema() {
  await initDatabase();

  const versionResult = db.exec('PRAGMA user_version');
  const currentVersion = versionResult[0]?.values[0]?.[0] || 0;

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
          db.run(stmt);
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

      db.run(`PRAGMA user_version = ${version}`);
      console.log(`[db] migration ${version} complete`);
    }

    saveDatabase();
  }

  // Recover from unclean shutdown: any jobs left in processing/running
  // can never complete (the process that was handling them is gone).
  const staleImports = db.exec("SELECT COUNT(*) FROM import_jobs WHERE status = 'processing'");
  const staleImportCount = staleImports[0]?.values[0]?.[0] || 0;
  if (staleImportCount > 0) {
    db.run("UPDATE import_jobs SET status = 'failed', error = 'Server restarted during processing', completed_at = CURRENT_TIMESTAMP WHERE status = 'processing'");
    console.log(`[db] Marked ${staleImportCount} stale import job(s) as failed`);
  }

  const staleTranscriptions = db.exec("SELECT COUNT(*) FROM transcription_jobs WHERE status = 'running'");
  const staleTranscriptionCount = staleTranscriptions[0]?.values[0]?.[0] || 0;
  if (staleTranscriptionCount > 0) {
    db.run("UPDATE transcription_jobs SET status = 'failed', error = 'Server restarted during processing', completed_at = CURRENT_TIMESTAMP WHERE status = 'running'");
    console.log(`[db] Marked ${staleTranscriptionCount} stale transcription job(s) as failed`);
  }

  if (staleImportCount > 0 || staleTranscriptionCount > 0) {
    saveDatabase();
  }

  return db;
}

// ── Transcription Jobs ──────────────────────────────────────────────────────

const transcriptionJobs = {
  create({ document_id, provider, model, temperature, initiated_by, image_path, additional_image_paths }) {
    const result = run(`
      INSERT INTO transcription_jobs
        (document_id, provider, model, temperature, initiated_by, image_path, additional_image_paths, status, log)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', '')
    `, [
      document_id,
      provider || null,
      model || null,
      temperature != null ? temperature : null,
      initiated_by || null,
      image_path,
      additional_image_paths ? JSON.stringify(additional_image_paths) : null
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

  markSubmitted(id) {
    db.run("UPDATE import_jobs SET submitted = 1 WHERE id = ?", [id]);
    saveDatabase();
  },

  delete(id) {
    return run("DELETE FROM import_jobs WHERE id = ?", [id]);
  }
};

// Helper to run query and return all results
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper to run query and return first result
function get(sql, params = []) {
  const results = all(sql, params);
  return results[0] || null;
}

// Helper to run insert/update/delete
function run(sql, params = []) {
  db.run(sql, params);
  // Capture these BEFORE saveDatabase() — db.export() can reset last_insert_rowid()
  const lastInsertRowid = db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0];
  const changes = db.getRowsModified();
  saveDatabase();
  return { lastInsertRowid, changes };
}

// ── Documents ──────────────────────────────────────────────────────────────

const documents = {
  // opts: { userId, isAdmin, accessAll } — omit or set isAdmin to bypass filtering
  getAll(limit = 20, offset = 0, opts = {}) {
    const { userId, isAdmin, accessAll } = opts;

    if (isAdmin || accessAll || !userId) {
      return all(`
        SELECT d.*,
               (SELECT COUNT(*) FROM transcripts WHERE document_id = d.id) as transcript_count
        FROM documents d
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
    if (!userId) return false;
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

    if (isAdmin || accessAll || !userId) {
      const result = get('SELECT COUNT(*) as count FROM documents');
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

  getDistinctTypes() {
    return all(`
      SELECT DISTINCT json_extract(metadata, '$.document_type') as doc_type
      FROM documents
      WHERE json_extract(metadata, '$.document_type') IS NOT NULL
        AND json_extract(metadata, '$.document_type') != ''
      ORDER BY doc_type
    `).map(r => r.doc_type);
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

  getDateRange() {
    const result = get(`
      SELECT MIN(date_created) as min_date, MAX(date_created) as max_date
      FROM documents
      WHERE date_created IS NOT NULL AND date_created != ''
    `);
    return result || { min_date: null, max_date: null };
  },

  getAllFiltered(limit = 20, offset = 0, opts = {}, filters = {}) {
    const { userId, isAdmin, accessAll } = opts;
    const { collectionId, docTypes, locations, dateFrom, dateTo } = filters;

    const conditions = [];
    const params = [];

    // Access control
    if (!isAdmin && !accessAll && userId) {
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
    }

    if (collectionId) {
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
    if (dateFrom) {
      conditions.push(`d.date_created >= ?`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`d.date_created <= ?`);
      params.push(dateTo);
    }

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
        provider, model, prompt, temperature, initiated_by, run_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      transcript.run_duration_ms || null
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
    if (!isAdmin && !accessAll && userId) {
      accessClause = `AND d.id IN (
        SELECT dc.document_id FROM document_collections dc
        INNER JOIN user_collection_access uca ON dc.collection_id = uca.collection_id
        WHERE uca.user_id = ${parseInt(userId)}
      )`;
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
      for (const term of searchTerms) {
        const regex = new RegExp(`(${term})`, 'gi');
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

  getAll() {
    return all('SELECT id, username, email, role, status, access_all, created_at FROM users ORDER BY created_at');
  },

  getPending() {
    return all("SELECT id, username, email, created_at FROM users WHERE status = 'pending' ORDER BY created_at");
  },

  create({ username, email, passwordHash, role, status }) {
    const result = run(
      'INSERT INTO users (username, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?)',
      [username, email || null, passwordHash, role || 'user', status || 'pending']
    );
    return result.lastInsertRowid;
  },

  approve(id, { role, accessAll }) {
    run(
      "UPDATE users SET status = 'active', role = ?, access_all = ? WHERE id = ?",
      [role || 'user', accessAll ? 1 : 0, id]
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

  delete(id) {
    return run('DELETE FROM users WHERE id = ?', [id]);
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

  getById(id) {
    return get('SELECT * FROM collections WHERE id = ?', [id]);
  },

  create({ name, description, is_public, createdBy }) {
    const result = run(
      'INSERT INTO collections (name, description, is_public, created_by) VALUES (?, ?, ?, ?)',
      [name, description || null, is_public ? 1 : 0, createdBy || null]
    );
    return result.lastInsertRowid;
  },

  update(id, { name, description, is_public }) {
    run('UPDATE collections SET name = ?, description = ?, is_public = ? WHERE id = ?',
      [name, description || null, is_public ? 1 : 0, id]);
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
    return row ? row.value : null;
  },

  getAll() {
    const rows = all('SELECT key, value FROM settings');
    return rows.reduce((acc, { key, value }) => {
      acc[key] = value;
      return acc;
    }, {});
  },

  set(key, value) {
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
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
  collections,
  documentCollections,
  userCollectionAccess,
  settings,
  transcriptionJobs,
  importJobs
};
