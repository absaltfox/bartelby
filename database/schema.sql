-- ============================================================
-- REFERENCE ONLY — not executed at runtime.
-- The live schema is managed by the MIGRATIONS array in db.js.
-- To change the schema, add a new migration there.
-- This file reflects the current target state for readability.
-- ============================================================

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
  -- Paradata: provenance of each transcription run
  provider TEXT,
  model TEXT,
  prompt TEXT,
  temperature REAL,
  initiated_by TEXT,
  run_duration_ms INTEGER,
  source_job_id INTEGER REFERENCES transcription_jobs(id) ON DELETE SET NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_source_job_document
  ON transcripts(source_job_id, document_id)
  WHERE source_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_annotations_transcript_id ON annotations(transcript_id);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  access_all INTEGER NOT NULL DEFAULT 0,
  can_use_system_api_keys INTEGER NOT NULL DEFAULT 0,
  mfa_method TEXT NOT NULL DEFAULT 'none',
  mfa_totp_secret TEXT,
  mfa_email_otp_hash TEXT,
  mfa_email_otp_expires_at DATETIME,
  mfa_email_otp_sent_at DATETIME,
  invite_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS user_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  model TEXT,
  vision_model TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

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


CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  is_world_public INTEGER NOT NULL DEFAULT 0,
  allow_export INTEGER NOT NULL DEFAULT 0,
  auto_group_pages INTEGER NOT NULL DEFAULT 0,
  preview_document_id INTEGER,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (preview_document_id) REFERENCES documents(id),
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

CREATE TABLE IF NOT EXISTS worker_leases (
  name TEXT PRIMARY KEY,
  claimed_at DATETIME,
  claimed_by TEXT
);

CREATE TABLE IF NOT EXISTS transcription_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT,
  model TEXT,
  temperature REAL,
  initiated_by TEXT,
  provider_key_scope TEXT,
  user_api_key_id INTEGER,
  requested_by_user_id INTEGER,
  image_path TEXT NOT NULL,
  additional_image_paths TEXT,
  log TEXT NOT NULL DEFAULT '',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  batch_finalization_claimed_at DATETIME,
  batch_finalization_claimed_by TEXT,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transcription_jobs_status ON transcription_jobs(status);
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_document_id ON transcription_jobs(document_id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('default_provider', 'openai'),
  ('openai_model', 'gpt-4o'),
  ('anthropic_model', 'claude-3-5-sonnet-20241022'),
  ('ollama_base_url', 'http://localhost:11434'),
  ('ollama_model', 'llava'),
  ('lmstudio_base_url', 'http://localhost:1234/v1'),
  ('lmstudio_model', 'local-model');
