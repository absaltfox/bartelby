'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

let db;

beforeAll(async () => {
  jest.resetModules();
  db = require('../../database/db');
  await db.initializeSchema({ runStaleJobRecovery: false });
}, 60_000);

it('getPreExistingCitationIds excludes manual citations from the reset set', async () => {
  const docId = await db.documentsAsync.create({
    title: 'R7 Doc', date_created: null, description: null,
    image_path: '/uploads/r7.png', metadata: {}
  });
  const txId = await db.transcriptsAsync.create({
    document_id: docId, content: 'manual citation transcript', transcriber: 'Manual', version: 1, notes: null
  });
  const entityId = await db.entitiesAsync.create({
    entity_type: 'person', canonical_name: 'Manual Subject', description: null, properties: {}
  });
  const llmCitation = await db.citations.create({
    entity_id: entityId, relationship_id: null, transcript_id: txId, document_id: docId,
    passage_start: 0, passage_end: 6, passage_text: 'manual',
    extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9
  });
  const manualCitation = await db.citations.create({
    entity_id: entityId, relationship_id: null, transcript_id: txId, document_id: docId,
    passage_start: 7, passage_end: 15, passage_text: 'citation',
    extraction_method: 'manual', extraction_model: null, confidence: 1.0,
    approval_status: 'approved', approval_method: 'manual'
  });

  const ids = await db.graphMaintenance.getPreExistingCitationIds(txId);
  expect(ids).toContain(llmCitation);
  expect(ids).not.toContain(manualCitation);
});
