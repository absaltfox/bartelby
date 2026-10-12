'use strict';

/**
 * Integration test — saving an edited transcript from the Document page.
 *
 * POST /documents/:id/transcripts/:transcriptId/content is what the inline
 * transcript editor (public/js/document-page.js) calls. It referenced a helper
 * that routes/documents.js never imported, so every save threw a
 * ReferenceError and answered 500. Nothing exercised the route, so nothing
 * caught it until the linter flagged the undefined name.
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

let app;
let db;
let agent;
let csrf;
let documentId;
let transcriptId;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : null;
}

function save(content) {
  return agent
    .post(`/documents/${documentId}/transcripts/${transcriptId}/content`)
    .set('X-CSRF-Token', csrf)
    .send({ content });
}

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  // Created directly rather than through /setup, and each step is asserted, so
  // a failure here names the step instead of surfacing as a 403 on every case.
  const { hashPassword } = require('../../utils/passwords');
  await db.usersAsync.create({
    username: 'transcriptsaver',
    email: 'transcriptsaver@example.test',
    passwordHash: await hashPassword('testpassword99!'),
    role: 'admin',
    status: 'active',
    accessAll: true,
    canUseSystemApiKeys: true
  });

  agent = request.agent(app);
  const loginPage = await agent.get('/login');
  const loginRes = await agent.post('/login').type('form').send({
    username: 'transcriptsaver', password: 'testpassword99!', _csrf: extractCsrfToken(loginPage.text)
  });
  expect(loginRes.headers.location).toBe('/');

  const accountPage = await agent.get('/account');
  expect(accountPage.status).toBe(200);
  csrf = extractCsrfToken(accountPage.text);
  expect(csrf).toBeTruthy();

  documentId = await db.documentsAsync.create({
    title: 'Editable letter', date_created: null, description: null, image_path: null, metadata: {}
  });
  transcriptId = await db.transcriptsAsync.create({
    document_id: documentId, content: 'Dear Sir, I recieved your letter.', transcriber: 'fixture', notes: null
  });
}, 60_000);

describe('POST /documents/:id/transcripts/:transcriptId/content', () => {
  it('saves edited content', async () => {
    const res = await save('Dear Sir, I received your letter.');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const stored = await db.transcriptsAsync.getById(transcriptId);
    expect(stored.content).toBe('Dear Sir, I received your letter.');
  });

  it('reports an unchanged save without error', async () => {
    const res = await save('Dear Sir, I received your letter.');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, unchanged: true });
  });

  it('answers 404 for a transcript that belongs to another document', async () => {
    const res = await agent
      .post(`/documents/${documentId + 999}/transcripts/${transcriptId}/content`)
      .set('X-CSRF-Token', csrf)
      .send({ content: 'x' });
    expect(res.status).toBe(404);
  });
});
