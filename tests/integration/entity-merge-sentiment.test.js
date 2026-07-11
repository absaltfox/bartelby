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

  it('mergeEntities re-points expressed_by_entity_id and described_subject_entity_id to the kept entity', async () => {
    const keepId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'Jane Keep', description: null, properties: {}
    });
    const mergeId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'Jane Merge', description: null, properties: {}
    });

    // Insert annotation with expressed_by_entity_id pointing at mergeId
    const rExpr = await db.runAsync(`
      INSERT INTO sentiment_annotations
        (transcript_id, document_id, span_start, span_end, polarity, intensity,
         voice_role, target_kind, emotion_phrase_verbatim, approval_status, expressed_by_entity_id)
      VALUES (?, ?, 0, 5, 'positive', 'moderate', 'author', 'theme', 'glad', 'pending', ?)
    `, [txId, docId, mergeId]);
    const exprAnnId = rExpr.lastInsertRowid;

    // Insert annotation with described_subject_entity_id pointing at mergeId
    const rSubj = await db.runAsync(`
      INSERT INTO sentiment_annotations
        (transcript_id, document_id, span_start, span_end, polarity, intensity,
         voice_role, target_kind, emotion_phrase_verbatim, approval_status, described_subject_entity_id)
      VALUES (?, ?, 6, 10, 'negative', 'low', 'author', 'theme', 'sad', 'pending', ?)
    `, [txId, docId, mergeId]);
    const subjAnnId = rSubj.lastInsertRowid;

    const { mergeEntities } = require('../../utils/entity-resolution');
    await mergeEntities(keepId, mergeId);

    const exprAnn = await db.getAsync(
      'SELECT expressed_by_entity_id FROM sentiment_annotations WHERE id = ?', [exprAnnId]
    );
    expect(exprAnn.expressed_by_entity_id).toBe(keepId);

    const subjAnn = await db.getAsync(
      'SELECT described_subject_entity_id FROM sentiment_annotations WHERE id = ?', [subjAnnId]
    );
    expect(subjAnn.described_subject_entity_id).toBe(keepId);
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
