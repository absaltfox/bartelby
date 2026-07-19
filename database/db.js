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
const {
  DEFAULT_BATCH_FINALIZATION_STALE_SECONDS,
  parseFinalizationStaleSeconds
} = require('../utils/finalization-claims');
const { AsyncLocalStorage } = require('async_hooks');

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

// v54 — link citations directly to date expressions for clearer review flows
MIGRATIONS.push(`
  ALTER TABLE citations ADD COLUMN date_expression_id INTEGER REFERENCES date_expressions(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_citations_date_expression ON citations(date_expression_id);
`);

// v55 — durable transcription batch finalization claims and transcript job provenance
MIGRATIONS.push(`
  ALTER TABLE transcription_jobs ADD COLUMN batch_finalization_claimed_at DATETIME;
  ALTER TABLE transcription_jobs ADD COLUMN batch_finalization_claimed_by TEXT;
  ALTER TABLE transcripts ADD COLUMN source_job_id INTEGER REFERENCES transcription_jobs(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_source_job_document
    ON transcripts(source_job_id, document_id)
    WHERE source_job_id IS NOT NULL;
`);

// v56 — durable extraction batch finalization claims and worker leases
MIGRATIONS.push(`
  ALTER TABLE extraction_jobs ADD COLUMN batch_finalization_claimed_at DATETIME;
  ALTER TABLE extraction_jobs ADD COLUMN batch_finalization_claimed_by TEXT;
  CREATE TABLE IF NOT EXISTS worker_leases (
    name TEXT PRIMARY KEY,
    claimed_at DATETIME,
    claimed_by TEXT
  );
`);

// v58 — batch support columns for import_jobs (repair)
// Migration v46 in migrations.js added these columns, but databases that were
// already at schema version ≥46 before that entry was inserted never ran it.
// Re-applying here as v58 ensures every instance gets the columns. The
// duplicate-column guard in initializeSchema() makes this safe for fresh
// databases that already applied v46.
MIGRATIONS.push(`
  ALTER TABLE import_jobs ADD COLUMN batch_remote_id TEXT;
  ALTER TABLE import_jobs ADD COLUMN batch_remote_status TEXT;
  ALTER TABLE import_jobs ADD COLUMN batch_manifest TEXT
`);

// v59 — authority layer for cross-document knowledge graph identity
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS authorities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    authority_type TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    description TEXT,
    properties TEXT NOT NULL DEFAULT '{}',
    external_source TEXT,
    external_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_authorities_type ON authorities(authority_type);
  CREATE INDEX IF NOT EXISTS idx_authorities_name ON authorities(canonical_name);
  CREATE INDEX IF NOT EXISTS idx_authorities_external ON authorities(external_source, external_key);

  ALTER TABLE entities ADD COLUMN authority_id INTEGER REFERENCES authorities(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_authority ON entities(authority_id);

  CREATE TABLE IF NOT EXISTS authority_link_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    suggested_authority_id INTEGER NOT NULL REFERENCES authorities(id) ON DELETE CASCADE,
    confidence REAL,
    match_method TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at DATETIME,
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (entity_id, suggested_authority_id)
  );
  CREATE INDEX IF NOT EXISTS idx_authority_link_suggestions_status ON authority_link_suggestions(status);
  CREATE INDEX IF NOT EXISTS idx_authority_link_suggestions_entity ON authority_link_suggestions(entity_id);
  CREATE INDEX IF NOT EXISTS idx_authority_link_suggestions_authority ON authority_link_suggestions(suggested_authority_id);
  CREATE INDEX IF NOT EXISTS idx_authority_link_suggestions_status_created ON authority_link_suggestions(status, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS authority_resolution_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'queued',
    entity_ids TEXT,
    batch_size INTEGER NOT NULL DEFAULT 100,
    processed_count INTEGER NOT NULL DEFAULT 0,
    resolved_count INTEGER NOT NULL DEFAULT 0,
    requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    log TEXT NOT NULL DEFAULT '',
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_authority_resolution_jobs_status ON authority_resolution_jobs(status);
`);

// v60 — async authority suggestion pipeline
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS authority_suggestion_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    entity_count INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    suggestion_count INTEGER NOT NULL DEFAULT 0,
    auto_approved_count INTEGER NOT NULL DEFAULT 0,
    fuzzy_threshold REAL NOT NULL DEFAULT 0.6,
    pending_threshold REAL NOT NULL DEFAULT 0.75,
    auto_approve_threshold REAL NOT NULL DEFAULT 0.92,
    requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    log TEXT NOT NULL DEFAULT '',
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_authority_suggestion_jobs_status ON authority_suggestion_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_authority_suggestion_jobs_collection ON authority_suggestion_jobs(collection_id)
`);

// v61 — editable generic authority terms and learning settings
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS authority_generic_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    normalized_term TEXT NOT NULL,
    entity_type TEXT,
    status TEXT NOT NULL DEFAULT 'suggested',
    source TEXT NOT NULL DEFAULT 'manual',
    seen_count INTEGER NOT NULL DEFAULT 0,
    rejected_link_count INTEGER NOT NULL DEFAULT 0,
    approved_link_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(normalized_term, entity_type)
  );
  CREATE INDEX IF NOT EXISTS idx_authority_generic_terms_status ON authority_generic_terms(status);
  CREATE INDEX IF NOT EXISTS idx_authority_generic_terms_entity_type ON authority_generic_terms(entity_type);
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('authority_generic_learning_enabled', '1'),
    ('authority_generic_learning_min_rejections', '3'),
    ('authority_generic_learning_min_seen', '5');
`);

// v62 — performance indexes and append-only job log storage
MIGRATIONS.push(`
  CREATE INDEX IF NOT EXISTS idx_document_collections_collection_document
    ON document_collections(collection_id, document_id);
  CREATE INDEX IF NOT EXISTS idx_user_collection_access_collection_user
    ON user_collection_access(collection_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_import_jobs_user_created_at
    ON import_jobs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transcription_jobs_status_created_at
    ON transcription_jobs(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transcription_jobs_created_at
    ON transcription_jobs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_import_jobs_status_created_at
    ON import_jobs(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_import_jobs_created_at
    ON import_jobs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_extraction_jobs_status_created_at
    ON extraction_jobs(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_extraction_jobs_created_at
    ON extraction_jobs(created_at DESC);
  CREATE TABLE IF NOT EXISTS job_log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    job_id INTEGER NOT NULL,
    line TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_job_log_entries_job
    ON job_log_entries(job_type, job_id, id);
`);

// v62 — authority suggestion review context indexes
MIGRATIONS.push(`
  CREATE INDEX IF NOT EXISTS idx_citations_entity_approval_created
    ON citations(entity_id, approval_status, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_citations_entity_approval_document
    ON citations(entity_id, approval_status, document_id);
`);

// v63 — reconcile already-satisfied authority suggestions
MIGRATIONS.push(`
  UPDATE authority_link_suggestions
  SET status = 'approved',
      reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP)
  WHERE status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM entities e
      WHERE e.id = authority_link_suggestions.entity_id
        AND e.authority_id = authority_link_suggestions.suggested_authority_id
    );
`);

// v65 — repair generic authority terms table on schemas that skipped v61 DDL
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS authority_generic_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    normalized_term TEXT NOT NULL,
    entity_type TEXT,
    status TEXT NOT NULL DEFAULT 'suggested',
    source TEXT NOT NULL DEFAULT 'manual',
    seen_count INTEGER NOT NULL DEFAULT 0,
    rejected_link_count INTEGER NOT NULL DEFAULT 0,
    approved_link_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(normalized_term, entity_type)
  );
  CREATE INDEX IF NOT EXISTS idx_authority_generic_terms_status ON authority_generic_terms(status);
  CREATE INDEX IF NOT EXISTS idx_authority_generic_terms_entity_type ON authority_generic_terms(entity_type);
  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('authority_generic_learning_enabled', '1'),
    ('authority_generic_learning_min_rejections', '3'),
    ('authority_generic_learning_min_seen', '5');
`);

// v66 — linked entities should not remain in the authority suggestion queue
MIGRATIONS.push(`
  UPDATE authority_link_suggestions
  SET status = 'rejected',
      reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP)
  WHERE status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM entities e
      WHERE e.id = authority_link_suggestions.entity_id
        AND e.authority_id IS NOT NULL
    );
`);

// v67 — sentiment analysis foundation (Phase 1: schema + extraction job + annotation + phrase)
MIGRATIONS.push(`
  ALTER TABLE collections ADD COLUMN sentiment_enabled INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS sentiment_emotion_phrases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phrase_text_normalized TEXT NOT NULL UNIQUE,
    embedding BLOB,
    embedding_model TEXT,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    usage_count   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sentiment_extraction_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   INTEGER NOT NULL,
    transcript_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','running','batch_submitted','done','failed')),
    kind   TEXT NOT NULL DEFAULT 'singleton'
      CHECK (kind IN ('singleton','batch')),
    reset_existing INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    batch_remote_id TEXT,
    batch_submitted_at DATETIME,
    batch_finalization_claimed_at DATETIME,
    batch_finalization_claimed_by TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    error TEXT,
    validation_drops TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id)   REFERENCES documents(id)   ON DELETE CASCADE,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sentiment_jobs_status_created
    ON sentiment_extraction_jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_sentiment_jobs_transcript
    ON sentiment_extraction_jobs(transcript_id);
  CREATE INDEX IF NOT EXISTS idx_sentiment_jobs_batch_remote
    ON sentiment_extraction_jobs(batch_remote_id);

  CREATE TABLE IF NOT EXISTS sentiment_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id INTEGER NOT NULL,
    document_id   INTEGER NOT NULL,
    span_start INTEGER,
    span_end   INTEGER,
    evidence_excerpt TEXT,
    polarity  TEXT NOT NULL CHECK (polarity  IN ('positive','negative','neutral','mixed')),
    intensity TEXT NOT NULL CHECK (intensity IN ('low','moderate','strong')),
    confidence REAL,
    voice_role  TEXT NOT NULL CHECK (voice_role  IN ('author','speaker','described_subject')),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('entity','phrase','theme')),
    target_entity_id INTEGER,
    target_phrase    TEXT,
    expressed_by_entity_id      INTEGER,
    described_subject_entity_id INTEGER,
    emotion_phrase_id INTEGER,
    emotion_phrase_verbatim TEXT NOT NULL,
    plutchik_hint TEXT,
    approval_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (approval_status IN ('pending','approved','rejected')),
    auto_approved INTEGER NOT NULL DEFAULT 0,
    reviewed_by INTEGER,
    reviewed_at DATETIME,
    review_note TEXT,
    extracted_by TEXT,
    extraction_job_id INTEGER,
    extracted_at DATETIME,
    replaced_at DATETIME,
    replaced_by_job_id INTEGER,
    FOREIGN KEY (transcript_id)               REFERENCES transcripts(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id)                 REFERENCES documents(id)   ON DELETE CASCADE,
    FOREIGN KEY (target_entity_id)            REFERENCES entities(id)    ON DELETE SET NULL,
    FOREIGN KEY (expressed_by_entity_id)      REFERENCES entities(id)    ON DELETE SET NULL,
    FOREIGN KEY (described_subject_entity_id) REFERENCES entities(id)    ON DELETE SET NULL,
    FOREIGN KEY (emotion_phrase_id)           REFERENCES sentiment_emotion_phrases(id) ON DELETE SET NULL,
    FOREIGN KEY (extraction_job_id)           REFERENCES sentiment_extraction_jobs(id) ON DELETE SET NULL,
    FOREIGN KEY (replaced_by_job_id)          REFERENCES sentiment_extraction_jobs(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by)                 REFERENCES users(id)       ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sentiment_ann_transcript_status
    ON sentiment_annotations(transcript_id, approval_status);
  CREATE INDEX IF NOT EXISTS idx_sentiment_ann_document_status
    ON sentiment_annotations(document_id, approval_status);
  CREATE INDEX IF NOT EXISTS idx_sentiment_ann_target_entity
    ON sentiment_annotations(target_entity_id);
  CREATE INDEX IF NOT EXISTS idx_sentiment_ann_emotion_phrase
    ON sentiment_annotations(emotion_phrase_id);
  CREATE INDEX IF NOT EXISTS idx_sentiment_ann_extraction_job
    ON sentiment_annotations(extraction_job_id);
  CREATE INDEX IF NOT EXISTS idx_sentiment_ann_status_created
    ON sentiment_annotations(approval_status, extracted_at);

  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('sentiment.prompt.default', ''),
    ('sentiment.auto_approve_threshold', '0.85'),
    ('sentiment.review_floor', '0.65'),
    ('sentiment.batch_min_jobs', '2'),
    ('sentiment.provider.default', ''),
    ('sentiment.vocab_debounce_phrase_count', '50'),
    ('sentiment.auto_route_threshold', '0.80')
`);

// v68 — collection browse performance indexes for Fly/Turso deployments
MIGRATIONS.push(`
  CREATE INDEX IF NOT EXISTS idx_documents_created_at
    ON documents(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_date_created
    ON documents(date_created);
  CREATE INDEX IF NOT EXISTS idx_documents_metadata_document_type
    ON documents(json_extract(metadata, '$.document_type'));
  CREATE INDEX IF NOT EXISTS idx_documents_metadata_location_norm
    ON documents(LOWER(TRIM(json_extract(metadata, '$.location'))));
`);

// v69 — sentiment Phase 1.5: paradata columns + per-annotation reasoning
MIGRATIONS.push(`
  ALTER TABLE sentiment_extraction_jobs ADD COLUMN submitted_prompt TEXT;
  ALTER TABLE sentiment_extraction_jobs ADD COLUMN model_name TEXT;
  ALTER TABLE sentiment_extraction_jobs ADD COLUMN prompt_template_hash TEXT;
  ALTER TABLE sentiment_extraction_jobs ADD COLUMN temperature REAL;
  ALTER TABLE sentiment_extraction_jobs ADD COLUMN system_prompt TEXT;
  ALTER TABLE sentiment_extraction_jobs ADD COLUMN extraction_notes TEXT;
  ALTER TABLE sentiment_annotations ADD COLUMN notes TEXT;
`);

// v70 — sentiment phrase clustering runs (Phase 2a)
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS sentiment_phrase_cluster_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'queued',
    params_json TEXT,
    cluster_count INTEGER,
    noise_count INTEGER,
    phrase_count INTEGER,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    triggered_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_sentiment_phrase_cluster_runs_status
    ON sentiment_phrase_cluster_runs(status);

  CREATE TABLE IF NOT EXISTS sentiment_phrase_clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES sentiment_phrase_cluster_runs(id) ON DELETE CASCADE,
    cluster_index INTEGER NOT NULL,
    size INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sentiment_phrase_clusters_run
    ON sentiment_phrase_clusters(run_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sentiment_phrase_clusters_run_index
    ON sentiment_phrase_clusters(run_id, cluster_index);

  CREATE TABLE IF NOT EXISTS sentiment_phrase_cluster_members (
    cluster_id INTEGER NOT NULL REFERENCES sentiment_phrase_clusters(id) ON DELETE CASCADE,
    phrase_id INTEGER NOT NULL REFERENCES sentiment_emotion_phrases(id) ON DELETE CASCADE,
    distance_to_centroid REAL,
    PRIMARY KEY (cluster_id, phrase_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sentiment_phrase_cluster_members_phrase
    ON sentiment_phrase_cluster_members(phrase_id);
`);

// v71 — Phase 2b: canonical labels for sentiment phrases (plus noise_phrase_ids_json on runs)
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS sentiment_phrase_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  ALTER TABLE sentiment_emotion_phrases
    ADD COLUMN canonical_label_id INTEGER
         REFERENCES sentiment_phrase_labels(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_sentiment_emotion_phrases_canonical_label
    ON sentiment_emotion_phrases(canonical_label_id);

  ALTER TABLE sentiment_phrase_cluster_runs
    ADD COLUMN noise_phrase_ids_json TEXT;
`);

// v72 — E3 unresolved-mention counters on extraction_jobs
MIGRATIONS.push(`
  ALTER TABLE extraction_jobs ADD COLUMN unresolved_relationship_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE extraction_jobs ADD COLUMN unresolved_date_count INTEGER NOT NULL DEFAULT 0;
`);

// v73 — S2.1: sentiment annotation temporal scope (emotion_about_*).
// Self-contained columns per docs/reviews/2026-05-31-entity-extraction-historian-lens.md
// S2.1 — deliberately NOT coupled to date_expressions (sentiment temporal
// scope is annotation-level metadata, not a graph-traversable node).
// Existing rows default to NULL per S2.3 forward-only rule.
MIGRATIONS.push(`
  ALTER TABLE sentiment_annotations ADD COLUMN emotion_about_phrase_verbatim TEXT;
  ALTER TABLE sentiment_annotations ADD COLUMN emotion_about_earliest TEXT;
  ALTER TABLE sentiment_annotations ADD COLUMN emotion_about_latest TEXT;
  ALTER TABLE sentiment_annotations ADD COLUMN emotion_about_precision TEXT;
  ALTER TABLE sentiment_annotations ADD COLUMN emotion_about_qualifier TEXT;
`);

// v74 — Knowledge graph remediation: extraction evidence drop counters and
// curator edit/split audit tables. The counters make "Trust LLM Verbatim, Not
// LLM Offsets" observable in admin job surfaces. The audit tables support C3
// entity edits and U5 split workflows without hiding curator changes inside
// entity properties JSON.
MIGRATIONS.push(`
  ALTER TABLE extraction_jobs ADD COLUMN dropped_verbatim_mismatch_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE extraction_jobs ADD COLUMN dropped_unknown_entity_mention_count INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS entity_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    change_note TEXT,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_entity_changes_entity
    ON entity_changes(entity_id, changed_at DESC);

  CREATE TABLE IF NOT EXISTS entity_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    created_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    split_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    split_note TEXT NOT NULL,
    split_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_entity_splits_source
    ON entity_splits(source_entity_id, split_at DESC);
  CREATE INDEX IF NOT EXISTS idx_entity_splits_created
    ON entity_splits(created_entity_id, split_at DESC);
`);

// v75 — Phase 4 sentiment research surfaces: equality indexes on the two
// entity-role columns that have no existing index. target_entity_id already
// has idx_sentiment_ann_target_entity from v67; expressed_by_entity_id and
// described_subject_entity_id are filtered by listResearchAnnotations
// (entity_id OR-condition) and networkSentimentEdges. Other research
// workloads are already covered by existing indexes:
//   - (document_id, approval_status)        v67  → document tab + per-doc rollups
//   - (approval_status, extracted_at)       v67  → default list ordering
//   - sentiment_emotion_phrases.canonical_label_id  v71  → label filter
// Add additional research-tuned indexes only after profiling real corpora.
MIGRATIONS.push(`
  CREATE INDEX IF NOT EXISTS idx_sentiment_ann_expressed_by
    ON sentiment_annotations(expressed_by_entity_id);
  CREATE INDEX IF NOT EXISTS idx_sentiment_ann_described_subject
    ON sentiment_annotations(described_subject_entity_id);
`);

// v76 — F1 of docs/2026-07-05-epistolary-register-design.md: epistolary
// register on sentiment annotations. 'conventional' = formulaic epistolary
// performance (openings, deference markers, closings, stock condolence);
// 'personal' = freshly composed emotional expression. NULL = unclassified —
// all pre-existing rows stay visibly unclassified rather than silently
// labeled (E5.2 precedent in the historian-lens review); no backfill.
MIGRATIONS.push(`
  ALTER TABLE sentiment_annotations ADD COLUMN register TEXT
    CHECK (register IN ('conventional','personal'));
`);

// v77 — D6 (2026-07-04 review): suppression keys were written by a local
// normalizer that skipped the trailing-punctuation strip, so keys like
// 'the school house.' never matched the listing's normalizePhraseSql join
// key and those suppressions silently did nothing. Renormalize existing
// keys with the canonical SQL expression (this literal SQL mirrors
// normalizePhraseSql in database/models/sentiment.js — keep them in sync;
// the ';' in the punctuation set is spelled CHAR(59) because the migration
// runner splits statements on literal semicolons).
// Dedupe first: two rows collapsing to the same key would violate the
// UNIQUE(target_phrase_normalized) constraint; the oldest row wins.
MIGRATIONS.push(`
  DELETE FROM sentiment_phrase_suppressions
   WHERE id NOT IN (
     SELECT MIN(id) FROM sentiment_phrase_suppressions
     GROUP BY LOWER(RTRIM(TRIM(REPLACE(REPLACE(REPLACE(target_phrase_normalized, '  ', ' '), '  ', ' '), '  ', ' ')), '.,' || CHAR(59) || ':!?'))
   );
  UPDATE sentiment_phrase_suppressions
     SET target_phrase_normalized = LOWER(RTRIM(TRIM(REPLACE(REPLACE(REPLACE(target_phrase_normalized, '  ', ' '), '  ', ' '), '  ', ' ')), '.,' || CHAR(59) || ':!?'));
`);

// v78 — curated collection coverage years. Both nullable: NULL means "no
// declared coverage" and the date-range hint/validation features stay off
// for that collection. Distinct from the derived min_year/max_year the
// landing-page queries compute from documents.date_created — those describe
// what has been extracted (and inherit its errors); these describe what the
// archivist knows the collection to span, so they can guide extraction.
MIGRATIONS.push(`
  ALTER TABLE collections ADD COLUMN date_range_start_year INTEGER;
  ALTER TABLE collections ADD COLUMN date_range_end_year INTEGER;
`);

// v79 — admin list-surface indexes from the 2026-07-11 performance
// investigation (Jobs page and Entity Evidence Review; see
// tests/unit/admin-list-query-plans.test.js for the plan guards).
// - sentiment_extraction_jobs(created_at DESC): the Jobs page "all" filter
//   orders by created_at with no status predicate, which the existing
//   (status, created_at) composite cannot serve.
// - authority_link_suggestions(created_at, confidence): covering index for
//   the per-job confidence-window aggregates on the Jobs page; without it
//   each of the 3 correlated subqueries per row full-scans the table.
// - citations(approval_status, created_at DESC): lets the review-queue list
//   stream in display order and stop at the page LIMIT instead of
//   materializing every matching citation.
MIGRATIONS.push(`
  CREATE INDEX IF NOT EXISTS idx_sentiment_jobs_created
    ON sentiment_extraction_jobs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_authority_link_suggestions_created_confidence
    ON authority_link_suggestions(created_at, confidence);
  CREATE INDEX IF NOT EXISTS idx_citations_approval_created
    ON citations(approval_status, created_at DESC);
`);

// v80 — title & summary backfill job family. Per
// docs/superpowers/specs/2026-07-11-title-backfill-design.md: one row per
// collection run; counters give the Jobs page live progress; failures are
// per-document and summarized in `error` (docs/background-jobs.md failure
// visibility rule).
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS title_backfill_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    provider TEXT,
    requested_by_user_id INTEGER,
    docs_total INTEGER NOT NULL DEFAULT 0,
    docs_processed INTEGER NOT NULL DEFAULT 0,
    titles_updated INTEGER NOT NULL DEFAULT 0,
    summaries_updated INTEGER NOT NULL DEFAULT 0,
    docs_failed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_title_backfill_jobs_status
    ON title_backfill_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_title_backfill_jobs_collection
    ON title_backfill_jobs(collection_id);
`);

// v81 — IIIF ingestion job family (feat/iiif-ingestion, Phase 1c). Per
// docs/background-jobs.md "Adding a New Worker Task": a job-shaped table with
// queued|running|done|failed status, started/completed timestamps, plus
// heartbeat/machine_id for stale recovery. Per docs/db-migrations.md this is
// appended (never mid-array) and uses idempotent CREATE … IF NOT EXISTS.
//
// iiif_sources — one row per admin-connected IIIF source (a UBC Open
//   Collections search or a generic IIIF Collection URL). The worker crawls it
//   into one document per manifest. Enumeration params are nullable because
//   they differ by source_type: ubc_oc uses search_base_url +
//   collection_identifier + query_json; iiif_collection uses source_url.
//   `cursor` persists paginated-crawl resume state (ES search_after / offset)
//   so a restart resumes without re-fetching. `api_key` is a secret and must
//   never be logged or leaked into stored image URLs.
// iiif_imported_manifests — idempotency ledger keyed UNIQUE(source_id,
//   manifest_id) so a re-sync creates zero duplicates and the ledger survives
//   document deletion.
MIGRATIONS.push(`
  CREATE TABLE IF NOT EXISTS iiif_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    search_base_url TEXT,
    collection_identifier TEXT,
    query_json TEXT,
    api_key TEXT,
    label TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    image_size TEXT,
    manifests_total INTEGER NOT NULL DEFAULT 0,
    manifests_imported INTEGER NOT NULL DEFAULT 0,
    cursor TEXT,
    last_synced_at DATETIME,
    machine_id TEXT,
    last_heartbeat_at DATETIME,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_iiif_sources_status
    ON iiif_sources(status);
  CREATE INDEX IF NOT EXISTS idx_iiif_sources_collection
    ON iiif_sources(collection_id);
  CREATE TABLE IF NOT EXISTS iiif_imported_manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    manifest_id TEXT NOT NULL,
    document_id INTEGER,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, manifest_id),
    FOREIGN KEY (source_id) REFERENCES iiif_sources(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_iiif_imported_manifests_source
    ON iiif_imported_manifests(source_id);
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
const transactionContext = new AsyncLocalStorage();

function getTransactionDriver() {
  return transactionContext.getStore()?.driver || null;
}

function saveDatabase() {
  if (!db) return Promise.resolve();
  if (db.persistent === false) return Promise.resolve();
  if (getTransactionDriver()) return Promise.resolve();
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

async function initializeSchema(options = {}) {
  const { runStaleJobRecovery = true } = options;
  await initDatabase();

  const currentVersion = await db.getSchemaVersion();

  if (currentVersion > MIGRATIONS.length) {
    // Warn — do not refuse to boot: the documented repair pattern
    // (docs/db-migrations.md, response A) deliberately leaves user_version
    // above the array length on locally-patched databases.
    console.error(
      `[db] SCHEMA DRIFT: PRAGMA user_version (${currentVersion}) is greater than `
      + `MIGRATIONS.length (${MIGRATIONS.length}). Any migration appended after a `
      + `consolidation event will silently skip on this database. `
      + `See docs/db-migrations.md ("Drift") for repair options.`
    );
  }

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

  // Seed the default sentiment prompt where the operator has not configured
  // one. The v67 migration seeds this key as '' (empty), because migrations
  // are split on ';' and the prompt template contains no safe SQL literal
  // form — so the real default is populated here, with the value BOUND as a
  // query parameter (no escaping) rather than interpolated. Fill-if-empty
  // only: a customized prompt is never clobbered (operators own their prompt
  // text — docs/2026-07-05-epistolary-register-design.md, F1 guardrail).
  try {
    const { DEFAULT_SENTIMENT_PROMPT } = require('../utils/sentiment/default-prompt');
    await db.run(
      `UPDATE settings SET value = ?
         WHERE key = 'sentiment.prompt.default'
           AND (value IS NULL OR value = '')`,
      [DEFAULT_SENTIMENT_PROMPT]
    );
  } catch (e) {
    console.error('[db] failed to seed default sentiment prompt:', e.message);
  }

  // Attempt to set up FTS5 virtual tables and sync triggers (idempotent).
  // Skipped silently on SQLite builds without fts5 (e.g. default sql.js).
  await ensureFts5();

  if (!runStaleJobRecovery) {
    await migrateEncryptedSettings();
    return db;
  }

  // Recover from unclean shutdown: any jobs left in processing/running
  // can never complete (the process that was handling them is gone).
  // Skip jobs with a machine_id — they run on ephemeral Fly machines
  // and may still be processing on a separate VM.
  //
  // This block is gated on `runStaleJobRecovery` because ephemeral
  // single-purpose processes (e.g. the standalone PDF render worker in
  // utils/pdf-worker.js) must not sweep state owned by the main app
  // process — doing so kills in-flight jobs of unrelated families. See
  // docs/background-jobs.md § Graceful Shutdown and Stale Job Recovery.
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
    // Mark failed rather than requeuing — in a multi-worker topology another
    // instance may still be actively processing the job.  Requeuing would let
    // a second worker claim and re-process it, causing duplicate documents and
    // transcription jobs.  Failed submission jobs can be retried manually.
    await db.run(`
      UPDATE import_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND COALESCE(job_kind, 'render') = 'submit'
    `);
    console.log(`[db] Marked ${staleSubmitImportCount} stale import submission job(s) as failed`);
  }

  const staleGroupingImports = await get(`
    SELECT COUNT(*) as count
    FROM import_jobs
    WHERE status = 'processing'
      AND COALESCE(job_kind, 'render') = 'grouping'
      AND batch_remote_id IS NULL
  `);
  const staleGroupingImportCount = staleGroupingImports?.count || 0;
  if (staleGroupingImportCount > 0) {
    // Mark failed rather than requeuing — same multi-worker race as submission
    // jobs: another instance may still be actively processing.
    await db.run(`
      UPDATE import_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'processing'
        AND COALESCE(job_kind, 'render') = 'grouping'
        AND batch_remote_id IS NULL
    `);
    console.log(`[db] Marked ${staleGroupingImportCount} stale grouping job(s) as failed`);
  }

  // Stale grouping batch jobs — provider may have completed while we were down.
  // Leave them in processing so the poll tick can resume.
  const staleGroupingBatches = await get(`
    SELECT COUNT(*) as count
    FROM import_jobs
    WHERE status = 'processing'
      AND COALESCE(job_kind, 'render') = 'grouping'
      AND batch_remote_id IS NOT NULL
  `);
  const staleGroupingBatchCount = staleGroupingBatches?.count || 0;
  if (staleGroupingBatchCount > 0) {
    console.log(`[db] Leaving ${staleGroupingBatchCount} grouping batch job(s) in processing state for poll resume`);
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

  const transcriptionBatchFinalizationStaleSeconds = parseFinalizationStaleSeconds(
    'BATCH_FINALIZATION_STALE_SECONDS',
    DEFAULT_BATCH_FINALIZATION_STALE_SECONDS
  );

  // Only clear genuinely stale batch finalization claims at startup. Fly can
  // overlap old and new processes during deploys or machine handoff, so
  // unconditionally clearing active claims can cause a live worker to lose its
  // durable lock mid-finalization.
  const staleTxBatchFinalizationClaims = await get(`
    SELECT COUNT(*) as count
    FROM transcription_jobs
    WHERE status = 'running'
      AND job_kind = 'batch'
      AND batch_finalization_claimed_at IS NOT NULL
      AND batch_finalization_claimed_at < datetime('now', ?)
  `, [`-${transcriptionBatchFinalizationStaleSeconds} seconds`]);
  const staleTxBatchFinalizationClaimCount = staleTxBatchFinalizationClaims?.count || 0;
  if (staleTxBatchFinalizationClaimCount > 0) {
    await db.run(`
      UPDATE transcription_jobs
      SET batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE status = 'running'
        AND job_kind = 'batch'
        AND batch_finalization_claimed_at IS NOT NULL
        AND batch_finalization_claimed_at < datetime('now', ?)
    `, [`-${transcriptionBatchFinalizationStaleSeconds} seconds`]);
    console.log(`[db] Cleared ${staleTxBatchFinalizationClaimCount} stale transcription batch finalization claim(s)`);
  }

  // Transcription batch jobs whose remote provider already returned results
  // should remain running so the worker can resume finalization safely on the
  // next poll. Marking them done here would skip any documents that were not
  // yet materialized locally.
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
    console.log(`[db] Leaving ${staleCompletedTxBatchCount} completed transcription batch job(s) in running state for finalization resume`);
  }

  // Batch jobs stranded on the 'pending%' submission sentinel: the process
  // died between the sentinel write and the real remote-id write. The poller
  // skips these and no reconciliation exists for transcription/extraction, so
  // without this sweep they wedge in `running` forever. Only rows older than
  // the stale window are failed — a live worker may be mid-submission.
  // Per docs/reviews/2026-07-06-application-reliability-review.md R2.
  const staleTxBatchPending = await get(`
    SELECT COUNT(*) as count
    FROM transcription_jobs
    WHERE status = 'running'
      AND job_kind = 'batch'
      AND batch_remote_id LIKE 'pending%'
      AND COALESCE(started_at, created_at) < datetime('now', ?)
  `, [`-${transcriptionBatchFinalizationStaleSeconds} seconds`]);
  const staleTxBatchPendingCount = staleTxBatchPending?.count || 0;
  if (staleTxBatchPendingCount > 0) {
    await db.run(`
      UPDATE transcription_jobs
      SET status = 'failed',
          error = 'Server restarted during batch submission (provider may have an orphaned batch). Sentinel: ' || batch_remote_id,
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND job_kind = 'batch'
        AND batch_remote_id LIKE 'pending%'
        AND COALESCE(started_at, created_at) < datetime('now', ?)
    `, [`-${transcriptionBatchFinalizationStaleSeconds} seconds`]);
    console.log(`[db] Marked ${staleTxBatchPendingCount} stale transcription batch-pending job(s) as failed.`);
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

  const extractionBatchFinalizationStaleSeconds = parseFinalizationStaleSeconds(
    'EXTRACTION_BATCH_FINALIZATION_STALE_SECONDS',
    DEFAULT_BATCH_FINALIZATION_STALE_SECONDS
  );

  const staleExtractionBatchFinalizationClaims = await getAsync(`
    SELECT COUNT(*) as count
    FROM extraction_jobs
    WHERE status = 'running'
      AND job_kind = 'batch'
      AND batch_finalization_claimed_at IS NOT NULL
      AND batch_finalization_claimed_at < datetime('now', ?)
  `, [`-${extractionBatchFinalizationStaleSeconds} seconds`]);
  const staleExtractionBatchFinalizationClaimCount = staleExtractionBatchFinalizationClaims?.count || 0;
  if (staleExtractionBatchFinalizationClaimCount > 0) {
    await db.run(`
      UPDATE extraction_jobs
      SET batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE status = 'running'
        AND job_kind = 'batch'
        AND batch_finalization_claimed_at IS NOT NULL
        AND batch_finalization_claimed_at < datetime('now', ?)
    `, [`-${extractionBatchFinalizationStaleSeconds} seconds`]);
    console.log(`[db] Cleared ${staleExtractionBatchFinalizationClaimCount} stale extraction batch finalization claim(s)`);
  }

  // Extraction batch jobs whose remote provider already returned results
  // should remain running so the worker can resume finalization safely on the
  // next poll. Marking them done here would skip any documents not yet
  // materialized into the knowledge graph.
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
    console.log(`[db] Leaving ${staleCompletedBatchCount} completed extraction batch job(s) in running state for finalization resume`);
  }

  // Extraction batch jobs stranded on the 'pending%' submission sentinel.
  // Per docs/reviews/2026-07-06-application-reliability-review.md R2.
  const staleExtractionBatchPending = await getAsync(`
    SELECT COUNT(*) as count
    FROM extraction_jobs
    WHERE status = 'running'
      AND job_kind = 'batch'
      AND batch_remote_id LIKE 'pending%'
      AND COALESCE(started_at, created_at) < datetime('now', ?)
  `, [`-${extractionBatchFinalizationStaleSeconds} seconds`]);
  const staleExtractionBatchPendingCount = staleExtractionBatchPending?.count || 0;
  if (staleExtractionBatchPendingCount > 0) {
    await db.run(`
      UPDATE extraction_jobs
      SET status = 'failed',
          error = 'Server restarted during batch submission (provider may have an orphaned batch). Sentinel: ' || batch_remote_id,
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND job_kind = 'batch'
        AND batch_remote_id LIKE 'pending%'
        AND COALESCE(started_at, created_at) < datetime('now', ?)
    `, [`-${extractionBatchFinalizationStaleSeconds} seconds`]);
    console.log(`[db] Marked ${staleExtractionBatchPendingCount} stale extraction batch-pending job(s) as failed.`);
  }

  const staleAuthorityResolutionJobs = await getAsync(`
    SELECT COUNT(*) as count
    FROM authority_resolution_jobs
    WHERE status = 'running'
  `);
  const staleAuthorityResolutionCount = staleAuthorityResolutionJobs?.count || 0;
  if (staleAuthorityResolutionCount > 0) {
    await db.run(`
      UPDATE authority_resolution_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `);
    console.log(`[db] Marked ${staleAuthorityResolutionCount} stale authority resolution job(s) as failed`);
  }

  const staleAuthoritySuggestionJobs = await getAsync(`
    SELECT COUNT(*) as count
    FROM authority_suggestion_jobs
    WHERE status = 'running'
  `);
  const staleAuthoritySuggestionCount = staleAuthoritySuggestionJobs?.count || 0;
  if (staleAuthoritySuggestionCount > 0) {
    await db.run(`
      UPDATE authority_suggestion_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `);
    console.log(`[db] Marked ${staleAuthoritySuggestionCount} stale authority suggestion job(s) as failed`);
  }

  const staleTitleBackfillJobs = await getAsync(`
    SELECT COUNT(*) as count
    FROM title_backfill_jobs
    WHERE status = 'running'
  `);
  const staleTitleBackfillCount = staleTitleBackfillJobs?.count || 0;
  if (staleTitleBackfillCount > 0) {
    await db.run(`
      UPDATE title_backfill_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `);
    console.log(`[db] Marked ${staleTitleBackfillCount} stale title backfill job(s) as failed`);
  }

  // IIIF sync sources left 'running' by an unclean shutdown are REQUEUED, not
  // failed: the iiif_imported_manifests ledger makes a re-crawl idempotent, so
  // resuming is safe and preferable to a manual admin retry. Only the
  // single-process path (machine_id IS NULL) is swept here; a future Fly-machine
  // crawl (machine_id set) is recovered by the heartbeat sweeper
  // (iiifSourcesAsync.requeueStaleJobs). Per docs/background-jobs.md
  // § Graceful Shutdown and Stale Job Recovery.
  const staleIiifSources = await getAsync(`
    SELECT COUNT(*) as count
    FROM iiif_sources
    WHERE status = 'running' AND machine_id IS NULL
  `);
  const staleIiifCount = staleIiifSources?.count || 0;
  if (staleIiifCount > 0) {
    await db.run(`
      UPDATE iiif_sources
      SET status = 'queued',
          started_at = NULL,
          completed_at = NULL,
          last_heartbeat_at = NULL
      WHERE status = 'running' AND machine_id IS NULL
    `);
    console.log(`[db] Requeued ${staleIiifCount} stale IIIF sync source(s)`);
  }

  // Sentiment singleton jobs in 'running' lost their executor on restart;
  // mark them failed. Batch rows in 'batch_submitted' are intentionally
  // left untouched — the provider still owns the work and
  // pollRunningSentimentBatchesTick will resume them. Batch rows in
  // 'running' are only swept here when a finalization claim is present
  // (the finalizer crashed mid-write); the claim is cleared so the next
  // tick can re-claim cleanly. See docs/background-jobs.md
  // § Graceful Shutdown and Stale Job Recovery.
  const staleSentimentSingleton = await getAsync(`
    SELECT COUNT(*) as count
    FROM sentiment_extraction_jobs
    WHERE status = 'running' AND kind = 'singleton'
  `);
  const staleSentimentSingletonCount = staleSentimentSingleton?.count || 0;
  if (staleSentimentSingletonCount > 0) {
    await db.run(`
      UPDATE sentiment_extraction_jobs
      SET status = 'failed',
          error = 'Server restarted during processing',
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running' AND kind = 'singleton'
    `);
    console.log(`[db] Marked ${staleSentimentSingletonCount} stale sentiment singleton job(s) as failed`);
  }

  // Sentiment batch in-flight state is `status = 'batch_submitted'` (Phase
  // 1.5 — see docs/background-jobs.md). The original recovery queries here
  // checked `status = 'running' AND kind = 'batch'`, which never matched any
  // real row and left stale finalization claims wedged across server
  // restarts. Mirror the transcription/extraction pattern: clear (don't
  // fail) genuinely stale claims so the next worker tick can re-claim and
  // finalize the provider batch.
  const sentimentBatchFinalizationStaleSeconds = parseFinalizationStaleSeconds(
    'SENTIMENT_BATCH_FINALIZATION_STALE_SECONDS',
    DEFAULT_BATCH_FINALIZATION_STALE_SECONDS
  );

  const staleSentimentBatchClaimed = await getAsync(`
    SELECT COUNT(*) as count
    FROM sentiment_extraction_jobs
    WHERE status = 'batch_submitted'
      AND batch_finalization_claimed_at IS NOT NULL
      AND batch_finalization_claimed_at < datetime('now', ?)
  `, [`-${sentimentBatchFinalizationStaleSeconds} seconds`]);
  const staleSentimentBatchClaimedCount = staleSentimentBatchClaimed?.count || 0;
  if (staleSentimentBatchClaimedCount > 0) {
    await db.run(`
      UPDATE sentiment_extraction_jobs
      SET batch_finalization_claimed_at = NULL,
          batch_finalization_claimed_by = NULL
      WHERE status = 'batch_submitted'
        AND batch_finalization_claimed_at IS NOT NULL
        AND batch_finalization_claimed_at < datetime('now', ?)
    `, [`-${sentimentBatchFinalizationStaleSeconds} seconds`]);
    console.log(`[db] Cleared ${staleSentimentBatchClaimedCount} stale sentiment batch finalization claim(s)`);
  }

  // `pending-<uuid>` is the correlation placeholder written by
  // markBatchPending before the provider call lands. If we crashed during
  // submission, the placeholder never got flipped to the real remote_id;
  // there's no batch to finalize against, so fail these rows (the provider
  // may still have an orphaned batch — surface the correlation id in the
  // error for forensic recovery).
  //
  // Orphan state: status='running' AND kind='batch' (markBatchPending sets
  // batch_remote_id and batch_submitted_at but leaves status='running').
  // The Phase 1.6a reconciliation tick has 30 min to flip the placeholder
  // to a real id before this recovery sweep fails the row at next startup.
  const staleSentimentBatchPending = await getAsync(`
    SELECT COUNT(*) as count FROM sentiment_extraction_jobs
     WHERE status = 'running'
       AND kind = 'batch'
       AND batch_remote_id LIKE 'pending-%'
       AND batch_submitted_at < datetime('now', ?)
  `, [`-${sentimentBatchFinalizationStaleSeconds} seconds`]);
  const staleSentimentBatchPendingCount = staleSentimentBatchPending?.count || 0;
  if (staleSentimentBatchPendingCount > 0) {
    await db.run(`
      UPDATE sentiment_extraction_jobs
         SET status = 'failed',
             error = 'Server restarted during batch submission (provider may have orphaned batch). Correlation: ' || batch_remote_id,
             completed_at = CURRENT_TIMESTAMP
       WHERE status = 'running'
         AND kind = 'batch'
         AND batch_remote_id LIKE 'pending-%'
         AND batch_submitted_at < datetime('now', ?)
    `, [`-${sentimentBatchFinalizationStaleSeconds} seconds`]);
    console.log(`[db] Marked ${staleSentimentBatchPendingCount} stale sentiment batch-pending job(s) as failed.`);
  }

  // Defensive: any `running` sentiment batch row with NULL batch_remote_id
  // was claimed by the worker but never made it past markBatchPending. Fail
  // with a clear message — caller can re-queue.
  const staleSentimentBatchUnsubmitted = await getAsync(`
    SELECT COUNT(*) as count FROM sentiment_extraction_jobs
     WHERE status = 'running'
       AND batch_remote_id IS NULL
  `);
  const staleSentimentBatchUnsubmittedCount = staleSentimentBatchUnsubmitted?.count || 0;
  if (staleSentimentBatchUnsubmittedCount > 0) {
    await db.run(`
      UPDATE sentiment_extraction_jobs
         SET status = 'failed',
             error = 'Server restarted before batch submission',
             completed_at = CURRENT_TIMESTAMP
       WHERE status = 'running'
         AND batch_remote_id IS NULL
    `);
    console.log(`[db] Marked ${staleSentimentBatchUnsubmittedCount} stale sentiment batch-unsubmitted job(s) as failed.`);
  }

  // Phase 2a: sentiment_phrase_cluster_runs left in 'running' after a
  // server restart get marked 'failed' (worker subprocess died with the
  // server; no recovery is possible — admin can re-trigger).
  const staleClusterRuns = await getAsync(`
    SELECT COUNT(*) as count FROM sentiment_phrase_cluster_runs
     WHERE status = 'running'
  `);
  const staleClusterRunCount = staleClusterRuns?.count || 0;
  if (staleClusterRunCount > 0) {
    await db.run(`
      UPDATE sentiment_phrase_cluster_runs
         SET status = 'failed',
             error = 'Server restarted during clustering run',
             completed_at = CURRENT_TIMESTAMP
       WHERE status = 'running'
    `);
    console.log(`[db] Marked ${staleClusterRunCount} stale sentiment cluster run(s) as failed.`);
  }

  if (
    staleRenderImportCount > 0
    || staleSubmitImportCount > 0
    || staleGroupingImportCount > 0
    || staleTranscriptionCount > 0
    || staleTxBatchFinalizationClaimCount > 0
    || staleExtractionCount > 0
    || staleCompletedTxBatchCount > 0
    || staleExtractionBatchFinalizationClaimCount > 0
    || staleCompletedBatchCount > 0
    || staleTxBatchPendingCount > 0
    || staleExtractionBatchPendingCount > 0
    || staleAuthorityResolutionCount > 0
    || staleAuthoritySuggestionCount > 0
    || staleSentimentSingletonCount > 0
    || staleSentimentBatchClaimedCount > 0
    || staleSentimentBatchPendingCount > 0
    || staleSentimentBatchUnsubmittedCount > 0
    || staleClusterRunCount > 0
  ) {
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
  const driver = getTransactionDriver() || db;
  const result = driver.run(sql, params);
  saveDatabase();
  return result;
}

function runWithoutSave(sql, params = []) {
  const driver = getTransactionDriver() || db;
  return driver.run(sql, params);
}

async function allAsync(sql, params = []) {
  const driver = getTransactionDriver() || db;
  return await driver.all(sql, params);
}

async function getAsync(sql, params = []) {
  const driver = getTransactionDriver() || db;
  return await driver.get(sql, params);
}

async function runAsync(sql, params = []) {
  const driver = getTransactionDriver() || db;
  const result = await driver.run(sql, params);
  if (!getTransactionDriver()) await saveDatabase();
  return result;
}

async function runAsyncWithoutSave(sql, params = []) {
  const driver = getTransactionDriver() || db;
  return await driver.run(sql, params);
}

async function withTransactionAsync(fn) {
  await initDatabase();
  if (getTransactionDriver()) {
    return await fn();
  }

  if (db && typeof db.transaction === 'function') {
    const result = await db.transaction(async (txDriver) =>
      transactionContext.run({ driver: txDriver }, fn)
    );
    await saveDatabase();
    return result;
  }

  await db.run('BEGIN');
  try {
    const result = await transactionContext.run({ driver: db }, fn);
    await db.run('COMMIT');
    await saveDatabase();
    return result;
  } catch (err) {
    try {
      await db.run('ROLLBACK');
    } catch (_) {}
    throw err;
  }
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
const { transcriptionJobs, transcriptionJobsAsync, importJobs, importJobsAsync, adminJobsAsync, extractionJobs, authorityResolutionJobs, authorityResolutionJobsAsync, authoritySuggestionJobs, titleBackfillJobs, iiifSourcesAsync } = require('./models/jobs')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all, runWithoutSave, runAsyncWithoutSave);
const { entities, entityAliases, dateExpressions, relationships, citations, graphMaintenance, relationshipTypes, authorities, authorityLinkSuggestions, authorityGenericTerms, graphAccess, hydrateEntity, hydrateRelationship, buildAccessibleDocumentFilter, buildCollectionDocumentFilter, buildKnowledgeCitationVisibilityFilter, buildCitationQueryConditions } = require('./models/knowledge-graph')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all, () => fts5Available);
const { collectionAnalyticsAsync, documentEmbeddingsAsync, collectionTopicsAsync, documentTopicAssignmentsAsync, topicEvolutionAsync, topicHierarchyAsync } = require('./models/analytics')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);
const { SECRET_SETTING_KEYS, settings, settingsAsync } = require('./models/settings')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);
const { appLogsAsync } = require('./models/logs')(db, runAsync, getAsync, allAsync, saveDatabase, run, get, all);
const {
  sentimentAsync,
  normalizePhrase: normalizeSentimentPhrase,
  normalizePhraseSql: normalizeSentimentPhraseSql,
  parseResearchFilters: parseSentimentResearchFilters,
  parseTimelineBucket: parseSentimentTimelineBucket,
  ResearchFilterError: SentimentResearchFilterError
} = require('./models/sentiment')(db, runAsync, getAsync, allAsync, saveDatabase);
const relationshipTypeAliasesAsync = require('./models/relationship-type-aliases')(db, runAsync, getAsync, allAsync, saveDatabase);
const authorityChronologyAsync = require('./models/authority-chronology')(db, runAsync, getAsync, allAsync, saveDatabase);
const sentimentPhraseSuppressionsAsync = require('./models/sentiment-phrase-suppressions')(db, runAsync, getAsync, allAsync, saveDatabase);

// Curator-access predicates ("can this user mutate this knowledge-graph row?").
// Constructed AFTER the underlying async models so the factory can close over
// them. See database/models/curator-access.js for the design rationale.
const { curatorAccessFactory } = require('./models/curator-access');
const curatorAccessAsync = curatorAccessFactory({
  documentCollectionsAsync,
  collectionsAsync,
  userCollectionAccessAsync,
  entitiesAsync: entities,
  citationsAsync: citations,
  relationshipsAsync: relationships,
  dateExpressionsAsync: dateExpressions,
  authoritySuggestionsAsync: authorityLinkSuggestions,
  roleAtLeast
});

function getDb() { return db; }

// ---------------------------------------------------------------------------
// Phase 4 helper: load a sentiment panel scoped by one of entity_id /
// authority_id / document_id. Replaces the 4-line "buildAccessConditions +
// parseSentimentResearchFilters + Promise.all([summarize, list])" dance that
// was previously copy-pasted across 5 route files. Centralizing also lets
// the soft-fail policy live in one place — failures here are logged but
// degrade to empty summary instead of bubbling, since sentiment is a
// secondary panel on most surfaces and a hard error would 500 the whole
// page.
// ---------------------------------------------------------------------------
async function loadSentimentEntityPanel(opts, queryParams, panelOpts = {}) {
  const limit = Number.isInteger(panelOpts.limit) ? panelOpts.limit : 5;
  try {
    const accessSql = documentsAsync.buildAccessConditions(opts || {});
    const filters = parseSentimentResearchFilters(queryParams || {}, {
      isAdmin: Boolean(opts && opts.isAdmin)
    });
    // Cheap existence check first — short-circuits the long tail of
    // entities / documents / authorities with no sentiment at all.
    // SQLite stops at the first matching row, vs the GROUP BY summary
    // and ORDER BY list both scanning the filtered set.
    const exists = await sentimentAsync.hasResearchAnnotations(filters, accessSql);
    if (!exists) {
      return { summary: [], recent: [], hasMore: false, error: null };
    }
    const queries = [sentimentAsync.summarizeByLabel(filters, accessSql)];
    if (limit > 0) {
      queries.push(sentimentAsync.listResearchAnnotations(filters, accessSql, { limit }));
    }
    const [summary, listResult] = await Promise.all(queries);
    return {
      summary,
      recent: listResult ? listResult.rows : [],
      hasMore: listResult ? Boolean(listResult.nextCursor) : false,
      error: null
    };
  } catch (err) {
    // Log loudly so operators can find the failure in logs; degrade to
    // empty so the parent page still renders.
    console.error('[sentiment] loadSentimentEntityPanel failed:', err && err.message ? err.message : err);
    return { summary: [], recent: [], hasMore: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  initDatabase,
  initializeSchema,
  saveDatabase,
  withTransactionAsync,
  allAsync,
  runAsync,
  getAsync,
  flushDatabase,
  getDb,
  loadSentimentEntityPanel,
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
  authorityResolutionJobs,
  authorityResolutionJobsAsync,
  authoritySuggestionJobs,
  authoritySuggestionJobsAsync: authoritySuggestionJobs,
  titleBackfillJobsAsync: titleBackfillJobs,
  iiifSourcesAsync,
  sentimentAsync,
  normalizeSentimentPhrase,
  normalizeSentimentPhraseSql,
  parseSentimentResearchFilters,
  parseSentimentTimelineBucket,
  SentimentResearchFilterError,
  relationshipTypes,
  relationshipTypesAsync: relationshipTypes,
  authorities,
  authoritiesAsync: authorities,
  authorityLinkSuggestions,
  authorityLinkSuggestionsAsync: authorityLinkSuggestions,
  authorityGenericTerms,
  authorityGenericTermsAsync: authorityGenericTerms,
  graphAccess,
  graphAccessAsync: graphAccess,
  relationshipTypeAliasesAsync,
  authorityChronologyAsync,
  sentimentPhraseSuppressionsAsync,
  curatorAccessAsync
};
