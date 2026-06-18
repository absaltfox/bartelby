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

let app;
let db;
let adminAgent;
const DOC_ID = 9810;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await setupAgent.post('/setup').type('form').send({
    username: 'doclinkadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'doclinkadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });

  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [DOC_ID, 'Doc Link Test']);
  await db.runAsync(
    `INSERT OR IGNORE INTO transcripts (id, document_id, content, version, is_best) VALUES (?, ?, ?, ?, ?)`,
    [DOC_ID * 10, DOC_ID, 'Some passage content for testing.', 1, 1]
  );
}, 60_000);

describe('Document reading view — create-entity button', () => {
  it('renders a button with data attributes the page script consumes', async () => {
    const res = await adminAgent.get(`/documents/${DOC_ID}`).expect(200);
    expect(res.text).toMatch(/data-document-create-entity[^>]*data-transcript-id="\d+"/);
    expect(res.text).toContain('<script src="/js/document-selection-prefill.js"></script>');
  });

  it('falls back to a plain link with transcriptId prefilled when JS is off (noscript)', async () => {
    const res = await adminAgent.get(`/documents/${DOC_ID}`).expect(200);
    expect(res.text).toMatch(/<a[^>]*href="\/admin\/knowledge\/entities\/new\?transcriptId=\d+"[^>]*data-document-create-entity-fallback/);
  });
});
