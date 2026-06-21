'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_DRIVER = process.env.DATABASE_DRIVER || 'sqljs';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'playwright-session-secret-for-tests-32ch';
process.env.BOOTSTRAP_ADMIN_TOKEN = process.env.BOOTSTRAP_ADMIN_TOKEN || 'playwright-bootstrap-token';

const { app, initApp } = require('../../server');

const port = parseInt(process.env.PORT || process.env.PLAYWRIGHT_PORT || '3107', 10);

async function seedCuratorBrowserFixture() {
  const db = require('../../database/db');
  await db.runAsync(
    `INSERT OR IGNORE INTO relationship_types
      (name, label, category, frequency, source_type, target_type)
     VALUES ('mentioned_in', 'Mentioned In', 'general', 'common', '', '')`
  );

  const document = await db.runAsync(
    `INSERT INTO documents (title, image_path, metadata)
     VALUES ('Playwright Curator UX Document', NULL, '{}')`
  );
  const documentId = document.lastInsertRowid;
  const transcriptContent = 'Playwright curator evidence appears in this transcript for preview focus.';
  const transcript = await db.runAsync(
    `INSERT INTO transcripts (document_id, content, transcriber, is_best)
     VALUES (?, ?, 'Playwright Test', 1)`,
    [documentId, transcriptContent]
  );
  const transcriptId = transcript.lastInsertRowid;

  const source = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name)
     VALUES ('person', 'Playwright Curator Source')`
  );
  const target = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name)
     VALUES ('role', 'Playwright Curator Role')`
  );
  const relationship = await db.runAsync(
    `INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type)
     VALUES (?, ?, 'mentioned_in')`,
    [source.lastInsertRowid, target.lastInsertRowid]
  );

  await db.runAsync(
    `INSERT INTO citations
       (entity_id, relationship_id, transcript_id, document_id, passage_start, passage_end,
        passage_text, extraction_method, extraction_model, approval_status, confidence)
     VALUES
       (NULL, ?, ?, ?, 0, 29, 'Playwright curator evidence appears',
        'llm_auto', 'playwright', 'pending', 0.71)`,
    [relationship.lastInsertRowid, transcriptId, documentId]
  );
}

async function seedPublicReaderBrowserFixture() {
  const db = require('../../database/db');
  await db.runAsync(
    `INSERT OR IGNORE INTO relationship_types
      (name, label, category, frequency, source_type, target_type)
     VALUES ('mentioned_in', 'Mentioned In', 'general', 'common', '', '')`
  );

  const publicCollection = await db.runAsync(
    `INSERT INTO collections
       (name, description, is_public, is_world_public, allow_export, auto_group_pages)
     VALUES ('Playwright Public Reader Collection', 'Visible without login', 0, 1, 0, 0)`
  );
  await db.runAsync(
    `INSERT INTO collections
       (name, description, is_public, is_world_public, allow_export, auto_group_pages)
     VALUES ('Playwright Private Reader Collection', 'Hidden without login', 0, 0, 0, 0)`
  );

  const document = await db.runAsync(
    `INSERT INTO documents (title, image_path, metadata)
     VALUES ('Playwright Public Reader Document', NULL, '{}')`
  );
  const documentId = document.lastInsertRowid;
  await db.runAsync(
    `INSERT INTO document_collections (document_id, collection_id)
     VALUES (?, ?)`,
    [documentId, publicCollection.lastInsertRowid]
  );
  const transcript = await db.runAsync(
    `INSERT INTO transcripts (document_id, content, transcriber, is_best)
     VALUES (?, 'Ada and Charles appear in public graph evidence.', 'Playwright Test', 1)`,
    [documentId]
  );
  const source = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name)
     VALUES ('person', 'Playwright Public Ada')`
  );
  const target = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name)
     VALUES ('person', 'Playwright Public Charles')`
  );
  const relationship = await db.runAsync(
    `INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type)
     VALUES (?, ?, 'mentioned_in')`,
    [source.lastInsertRowid, target.lastInsertRowid]
  );

  for (const entityId of [source.lastInsertRowid, target.lastInsertRowid]) {
    await db.runAsync(
      `INSERT INTO citations
         (entity_id, relationship_id, transcript_id, document_id, passage_start, passage_end,
          passage_text, extraction_method, extraction_model, approval_status, confidence)
       VALUES
         (?, NULL, ?, ?, 0, 44, 'Ada and Charles appear in public graph evidence.',
          'manual', 'playwright', 'approved', 1)`,
      [entityId, transcript.lastInsertRowid, documentId]
    );
  }
  await db.runAsync(
    `INSERT INTO citations
       (entity_id, relationship_id, transcript_id, document_id, passage_start, passage_end,
        passage_text, extraction_method, extraction_model, approval_status, confidence)
     VALUES
       (NULL, ?, ?, ?, 0, 44, 'Ada and Charles appear in public graph evidence.',
        'manual', 'playwright', 'approved', 1)`,
    [relationship.lastInsertRowid, transcript.lastInsertRowid, documentId]
  );
}

initApp()
  .then(seedCuratorBrowserFixture)
  .then(seedPublicReaderBrowserFixture)
  .then(() => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`[playwright] Bartelby test server listening on http://127.0.0.1:${port}`);
    });

    function shutdown() {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('[playwright] Failed to start Bartelby test server:', err);
    process.exit(1);
  });
