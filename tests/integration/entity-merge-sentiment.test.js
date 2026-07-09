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

async function makeAnnotation(docId, txId, targetEntityId) {
  const r = await db.runAsync(`
    INSERT INTO sentiment_annotations
      (transcript_id, document_id, span_start, span_end, polarity, intensity,
       voice_role, target_kind, target_entity_id, emotion_phrase_verbatim, approval_status)
    VALUES (?, ?, 0, 5, 'positive', 'moderate', 'author', 'entity', ?, 'happy', 'approved')
  `, [txId, docId, targetEntityId]);
  return r.lastInsertRowid;
}

describe('entity merge and rerun cleanup vs sentiment annotations', () => {
  let docId; let txId;

  beforeAll(async () => {
    docId = await db.documentsAsync.create({
      title: 'R5 Doc', date_created: null, description: null,
      image_path: '/uploads/r5.png', metadata: {}
    });
    txId = await db.transcriptsAsync.create({
      document_id: docId, content: 'happy words about John', transcriber: 'Manual', version: 1, notes: null
    });
  });

  it('mergeEntities re-points annotation entity targets to the kept entity', async () => {
    const keepId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'John Jessop (keep)', description: null, properties: {}
    });
    const mergeId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'J. Jessop (merge)', description: null, properties: {}
    });
    const annId = await makeAnnotation(docId, txId, mergeId);

    const { mergeEntities } = require('../../utils/entity-resolution');
    await mergeEntities(keepId, mergeId);

    const ann = await db.getAsync('SELECT target_entity_id FROM sentiment_annotations WHERE id = ?', [annId]);
    expect(ann.target_entity_id).toBe(keepId);
  });

  it('resetCitationsById keeps an entity that sentiment annotations still reference', async () => {
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'Annotated Only', description: null, properties: {}
    });
    const citationId = await db.citations.create({
      entity_id: entityId, relationship_id: null, transcript_id: txId, document_id: docId,
      passage_start: 0, passage_end: 5, passage_text: 'happy',
      extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9
    });
    await makeAnnotation(docId, txId, entityId);

    await db.graphMaintenance.resetCitationsById([citationId]);

    const entity = await db.getAsync('SELECT id FROM entities WHERE id = ?', [entityId]);
    expect(entity).toBeTruthy();
  });
});
