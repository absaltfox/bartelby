'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : null;
}

let app; let db; let adminAgent; let csrf;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  await setupAgent.post('/setup').type('form').send({
    username: 'orphanadmin', password: 'pw-abcdefgh99!', confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN, _csrf: extractCsrfToken(setupPage.text)
  });
  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  await adminAgent.post('/login').type('form').send({
    username: 'orphanadmin', password: 'pw-abcdefgh99!', _csrf: extractCsrfToken(loginPage.text)
  });
  const page = await adminAgent.get('/admin/knowledge/review-extractions');
  csrf = extractCsrfToken(page.text);
}, 60_000);

async function makePendingCitedEntity(tag) {
  const docId = await db.documentsAsync.create({
    title: `Orphan ${tag}`, date_created: null, description: null,
    image_path: `/uploads/orphan-${tag}.png`, metadata: {}
  });
  const txId = await db.transcriptsAsync.create({
    document_id: docId, content: 'orphan cleanup transcript', transcriber: 'Manual', version: 1, notes: null
  });
  const entityId = await db.entitiesAsync.create({
    entity_type: 'person', canonical_name: `Orphan Subject ${tag}`, description: null, properties: {}
  });
  const citationId = await db.citations.create({
    entity_id: entityId, relationship_id: null, transcript_id: txId, document_id: docId,
    passage_start: 0, passage_end: 6, passage_text: 'orphan',
    extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.5
  });
  return { entityId, citationId, txId, docId };
}

it('bulk delete removes the now-orphaned entity along with its only citation', async () => {
  const { entityId, citationId } = await makePendingCitedEntity('bulk');
  await adminAgent.post('/admin/knowledge/review-extractions/bulk/delete')
    .set('X-CSRF-Token', csrf)
    .send({ ids: [citationId] })
    .expect(200);
  const entity = await db.getAsync('SELECT id FROM entities WHERE id = ?', [entityId]);
  expect(entity).toBeFalsy();
});

it('bulk delete keeps an entity that still has another citation', async () => {
  const { entityId, citationId, txId, docId } = await makePendingCitedEntity('keep');
  await db.citations.create({
    entity_id: entityId, relationship_id: null, transcript_id: txId, document_id: docId,
    passage_start: 7, passage_end: 14, passage_text: 'cleanup',
    extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9
  });
  await adminAgent.post('/admin/knowledge/review-extractions/bulk/delete')
    .set('X-CSRF-Token', csrf)
    .send({ ids: [citationId] })
    .expect(200);
  const entity = await db.getAsync('SELECT id FROM entities WHERE id = ?', [entityId]);
  expect(entity).toBeTruthy();
});
