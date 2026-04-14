'use strict';

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
  `,

  // v34 — separate cost-per-token rates for the utility model tier on personal API keys
  `
  ALTER TABLE user_api_keys ADD COLUMN utility_input_cost_per_mtok REAL;
  ALTER TABLE user_api_keys ADD COLUMN utility_output_cost_per_mtok REAL
  `,

  // v35 — unknown word count per transcript (count of [illegible] and [unclear:...])
  `ALTER TABLE transcripts ADD COLUMN unknown_word_count INTEGER`,

  // v36 — per-collection analytics snapshot
  `
  CREATE TABLE IF NOT EXISTS collection_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    computed_at DATETIME NOT NULL DEFAULT (datetime('now')),
    document_count INTEGER NOT NULL DEFAULT 0,
    storage_bytes INTEGER NOT NULL DEFAULT 0,
    transcribed_count INTEGER NOT NULL DEFAULT 0,
    untranscribed_count INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL,
    avg_confidence REAL,
    avg_unknown_words REAL,
    page_count_at_run INTEGER NOT NULL DEFAULT 0,
    topics_computed INTEGER NOT NULL DEFAULT 0
  )
  `,

  // v37 — per-document embeddings (keyed on document_id + collection_id)
  `
  CREATE TABLE IF NOT EXISTS document_embeddings (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    embedding TEXT NOT NULL,
    embedding_model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
    computed_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, collection_id)
  )
  `,

  // v38 — topic definitions per collection (replaced on every analytics run)
  `
  CREATE TABLE IF NOT EXISTS collection_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL,
    topic_label TEXT NOT NULL,
    topic_words TEXT NOT NULL,
    document_count INTEGER NOT NULL DEFAULT 0,
    parent_topic_id INTEGER,
    computed_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )
  `,

  // v39 — per-document topic assignments + UMAP coordinates (replaced on every analytics run)
  `
  CREATE TABLE IF NOT EXISTS document_topic_assignments (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL,
    probability REAL,
    x_coord REAL,
    y_coord REAL,
    computed_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (document_id, collection_id)
  )
  `,

  // v40 — topic evolution over time (replaced on every analytics run)
  `
  CREATE TABLE IF NOT EXISTS topic_evolution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL,
    time_period TEXT NOT NULL,
    document_count INTEGER NOT NULL DEFAULT 0,
    computed_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )
  `,

  // v41 — per-collection topic hierarchy payload for dendrogram rendering
  `
  CREATE TABLE IF NOT EXISTS topic_hierarchy (
    collection_id INTEGER PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
    hierarchy_json TEXT NOT NULL DEFAULT '[]',
    plot_json TEXT,
    computed_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )
  `,

  // v42 — provider batch transcription jobs + explicit document membership
  `
  ALTER TABLE transcription_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'single';
  ALTER TABLE transcription_jobs ADD COLUMN batch_display_name TEXT;
  ALTER TABLE transcription_jobs ADD COLUMN batch_document_count INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE transcription_jobs ADD COLUMN batch_page_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE transcription_jobs ADD COLUMN batch_completed_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE transcription_jobs ADD COLUMN batch_failed_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE transcription_jobs ADD COLUMN batch_remote_id TEXT;
  ALTER TABLE transcription_jobs ADD COLUMN batch_remote_status TEXT;
  ALTER TABLE transcription_jobs ADD COLUMN batch_manifest TEXT;
  CREATE TABLE IF NOT EXISTS transcription_job_documents (
    job_id INTEGER NOT NULL REFERENCES transcription_jobs(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    PRIMARY KEY (job_id, document_id)
  );
  CREATE INDEX IF NOT EXISTS idx_transcription_job_documents_document_id
    ON transcription_job_documents(document_id);
  CREATE INDEX IF NOT EXISTS idx_transcription_job_documents_job_id
    ON transcription_job_documents(job_id)
  `,

  // v43 — durable import submission jobs
  `
  ALTER TABLE import_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'render';
  ALTER TABLE import_jobs ADD COLUMN submit_payload TEXT
  `,

  // v44 — knowledge graph entities, citations, and extraction jobs
  `
  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    description TEXT,
    properties TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name);

  CREATE TABLE IF NOT EXISTS entity_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'extracted',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias);
  CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity ON entity_aliases(entity_id);

  CREATE TABLE IF NOT EXISTS date_expressions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    earliest TEXT,
    latest TEXT,
    precision TEXT NOT NULL DEFAULT 'unknown',
    qualifier TEXT,
    calendar TEXT NOT NULL DEFAULT 'gregorian',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_date_expressions_entity ON date_expressions(entity_id);
  CREATE INDEX IF NOT EXISTS idx_date_expressions_range ON date_expressions(earliest, latest);

  CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    label TEXT,
    properties TEXT NOT NULL DEFAULT '{}',
    confidence REAL,
    start_date TEXT,
    end_date TEXT,
    date_precision TEXT,
    date_qualifier TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(relationship_type);

  CREATE TABLE IF NOT EXISTS citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
    relationship_id INTEGER REFERENCES relationships(id) ON DELETE CASCADE,
    transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    passage_start INTEGER,
    passage_end INTEGER,
    passage_text TEXT NOT NULL,
    extraction_method TEXT NOT NULL,
    extraction_model TEXT,
    confidence REAL,
    reviewed_at DATETIME,
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_citations_entity ON citations(entity_id);
  CREATE INDEX IF NOT EXISTS idx_citations_relationship ON citations(relationship_id);
  CREATE INDEX IF NOT EXISTS idx_citations_transcript ON citations(transcript_id);
  CREATE INDEX IF NOT EXISTS idx_citations_document ON citations(document_id);
  CREATE INDEX IF NOT EXISTS idx_citations_reviewed ON citations(reviewed_at);

  CREATE TABLE IF NOT EXISTS extraction_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    provider TEXT,
    model TEXT,
    temperature REAL,
    initiated_by TEXT,
    provider_key_scope TEXT,
    user_api_key_id INTEGER REFERENCES user_api_keys(id) ON DELETE SET NULL,
    requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    log TEXT NOT NULL DEFAULT '',
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    entity_count INTEGER NOT NULL DEFAULT 0,
    relationship_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_extraction_jobs_status ON extraction_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_extraction_jobs_transcript ON extraction_jobs(transcript_id);
  CREATE INDEX IF NOT EXISTS idx_extraction_jobs_document ON extraction_jobs(document_id)
  `,

  // v45 — controlled relationship vocabulary for the knowledge graph
  `
  CREATE TABLE IF NOT EXISTS relationship_types (
    name TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    inverse_name TEXT,
    source_type TEXT,
    target_type TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO relationship_types (name, label, inverse_name, source_type, target_type, category) VALUES
    ('authored', 'Authored', NULL, 'document', 'person', 'document'),
    ('received', 'Received', NULL, 'document', 'person', 'document'),
    ('mentioned_in', 'Mentioned In', NULL, NULL, 'document', 'document'),
    ('sent_from', 'Sent From', NULL, 'document', 'place', 'document'),
    ('sent_to', 'Sent To', NULL, 'document', 'place', 'document'),
    ('references', 'References', NULL, NULL, NULL, 'document'),
    ('responds_to', 'Responds To', NULL, 'document', 'document', 'document'),
    ('co_filed_with', 'Co-filed With', NULL, 'document', 'document', 'document'),
    ('concerns', 'Concerns', NULL, 'document', 'topic', 'document'),
    ('resided_at', 'Resided At', NULL, 'person', 'place', 'spatial'),
    ('traveled_to', 'Traveled To', NULL, NULL, 'place', 'spatial'),
    ('born_in', 'Born In', NULL, 'person', 'place', 'spatial'),
    ('died_in', 'Died In', NULL, 'person', 'place', 'spatial'),
    ('located_in', 'Located In', NULL, NULL, 'place', 'spatial'),
    ('employed_by', 'Employed By', NULL, 'person', 'organization', 'organizational'),
    ('member_of', 'Member Of', NULL, 'person', 'organization', 'organizational'),
    ('holds_role_in', 'Holds Role In', NULL, 'person', 'organization', 'organizational'),
    ('founded', 'Founded', NULL, 'person', 'organization', 'organizational'),
    ('affiliated_with', 'Affiliated With', NULL, NULL, 'organization', 'organizational'),
    ('parent_of', 'Parent Of', 'child_of', 'person', 'person', 'familial'),
    ('child_of', 'Child Of', 'parent_of', 'person', 'person', 'familial'),
    ('spouse_of', 'Spouse Of', 'spouse_of', 'person', 'person', 'familial'),
    ('sibling_of', 'Sibling Of', 'sibling_of', 'person', 'person', 'familial'),
    ('related_to', 'Related To', 'related_to', NULL, NULL, 'general'),
    ('participated_in', 'Participated In', NULL, NULL, 'event', 'event'),
    ('occurred_at', 'Occurred At', NULL, 'event', 'place', 'event'),
    ('occurred_on', 'Occurred On', NULL, 'event', 'date', 'event'),
    ('caused_by', 'Caused By', NULL, 'event', NULL, 'event'),
    ('dated', 'Dated', NULL, NULL, 'date', 'temporal'),
    ('active_during', 'Active During', NULL, NULL, 'date', 'temporal'),
    ('owns', 'Owns', NULL, NULL, 'artifact', 'artifact'),
    ('created', 'Created', NULL, NULL, 'artifact', 'artifact'),
    ('associated_with', 'Associated With', NULL, NULL, 'artifact', 'artifact'),
    ('makes_claim', 'Makes Claim', NULL, 'document', 'claim', 'interpretive'),
    ('supports_claim', 'Supports Claim', NULL, NULL, 'claim', 'interpretive'),
    ('opposes_claim', 'Opposes Claim', NULL, NULL, 'claim', 'interpretive'),
    ('claim_concerns', 'Claim Concerns', NULL, 'claim', 'topic', 'interpretive'),
    ('related_to_topic', 'Related To Topic', NULL, NULL, 'topic', 'interpretive')
  `
];

const FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, canonical_name) VALUES (new.id, new.canonical_name);
  END`,
  `CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE OF canonical_name ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, canonical_name) VALUES('delete', old.id, old.canonical_name);
    INSERT INTO entities_fts(rowid, canonical_name) VALUES (new.id, new.canonical_name);
  END`,
  `CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, canonical_name) VALUES('delete', old.id, old.canonical_name);
  END`,
  `CREATE TRIGGER IF NOT EXISTS entity_aliases_fts_insert AFTER INSERT ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(rowid, alias) VALUES (new.id, new.alias);
  END`,
  `CREATE TRIGGER IF NOT EXISTS entity_aliases_fts_update AFTER UPDATE OF alias ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(entity_aliases_fts, rowid, alias) VALUES('delete', old.id, old.alias);
    INSERT INTO entity_aliases_fts(rowid, alias) VALUES (new.id, new.alias);
  END`,
  `CREATE TRIGGER IF NOT EXISTS entity_aliases_fts_delete AFTER DELETE ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(entity_aliases_fts, rowid, alias) VALUES('delete', old.id, old.alias);
  END`
];

module.exports = { MIGRATIONS, FTS_TRIGGERS };
