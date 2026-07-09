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

let app; let db; let adminAgent;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  await setupAgent.post('/setup').type('form').send({
    username: 'auditadmin', password: 'pw-abcdefgh99!', confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN, _csrf: extractCsrfToken(setupPage.text)
  });
  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  await adminAgent.post('/login').type('form').send({
    username: 'auditadmin', password: 'pw-abcdefgh99!', _csrf: extractCsrfToken(loginPage.text)
  });
}, 60_000);

it('does not flag excerpts that differ from the transcript only by collapsed whitespace', async () => {
  const docId = await db.documentsAsync.create({
    title: 'Audit Doc', date_created: null, description: null,
    image_path: '/uploads/audit.png', metadata: {}
  });
  const txId = await db.transcriptsAsync.create({
    document_id: docId, content: 'the school\nhouse was  painted red', transcriber: 'Manual', version: 1, notes: null
  });
  const entityId = await db.entitiesAsync.create({
    entity_type: 'place', canonical_name: 'school house', description: null, properties: {}
  });
  // Excerpt as buildCitationExcerpt stores it: whitespace collapsed + ellipses.
  await db.citations.create({
    entity_id: entityId, relationship_id: null, transcript_id: txId, document_id: docId,
    passage_start: 4, passage_end: 16, passage_text: '...the school house was painted red...',
    extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9
  });
  // A genuinely fabricated passage must still be flagged.
  await db.citations.create({
    entity_id: entityId, relationship_id: null, transcript_id: txId, document_id: docId,
    passage_start: 0, passage_end: 10, passage_text: 'this text is not in the transcript at all',
    extraction_method: 'llm_auto', extraction_model: 'test', confidence: 0.9
  });

  const res = await adminAgent.get('/admin/knowledge/review-extractions/audit-verbatim').expect(200);
  const flaggedTexts = res.body.samples.map((s) => s.passageText);
  expect(flaggedTexts).toContain('this text is not in the transcript at all');
  expect(flaggedTexts).not.toContain('...the school house was painted red...');
});
