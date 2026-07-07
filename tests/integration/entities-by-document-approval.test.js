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

describe('entitiesAsync.getByDocumentId approvalStatus handling', () => {
  let docId; let entityId;

  beforeAll(async () => {
    docId = await db.documentsAsync.create({
      title: 'D1 Doc', date_created: null, description: null,
      image_path: '/uploads/d1.png', metadata: {}
    });
    const txId = await db.transcriptsAsync.create({
      document_id: docId, content: 'John Jessop wrote this letter.', transcriber: 'Manual', version: 1, notes: null
    });
    entityId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'John Jessop', description: null, properties: {}
    });
    // Low confidence → deriveCitationApproval leaves it pending.
    await db.citations.create({
      entity_id: entityId, relationship_id: null, transcript_id: txId, document_id: docId,
      passage_start: 0, passage_end: 11, passage_text: 'John Jessop',
      extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.5
    });
  });

  it('default remains approved-only (pending-cited entity excluded)', async () => {
    const rows = await db.entitiesAsync.getByDocumentId(docId, {});
    expect(rows.map((r) => r.id)).not.toContain(entityId);
  });

  it('explicit approvalStatus: null skips the filter (pending-cited entity included)', async () => {
    const rows = await db.entitiesAsync.getByDocumentId(docId, { approvalStatus: null });
    expect(rows.map((r) => r.id)).toContain(entityId);
  });
});
