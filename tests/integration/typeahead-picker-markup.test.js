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
let adminAgent;

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await setupAgent.post('/setup').type('form').send({
    username: 'pickeradmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'pickeradmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });
}, 60_000);

describe('Typeahead picker markup — C1', () => {
  it('entity-new renders authority typeahead pointing at authorities/api/search', async () => {
    const res = await adminAgent.get('/admin/knowledge/entities/new').expect(200);
    expect(res.text).toMatch(/data-typeahead-picker[^>]*data-search-url="\/admin\/knowledge\/authorities\/api\/search"[^>]*data-field-name="authority_id"/);
    expect(res.text).toContain('<script src="/js/typeahead-picker.js"></script>');
  });

  it('entity-new transcript picker points at api/documents/search and field name is transcriptId', async () => {
    const res = await adminAgent.get('/admin/knowledge/entities/new').expect(200);
    expect(res.text).toMatch(/data-typeahead-picker[^>]*data-search-url="\/admin\/knowledge\/api\/documents\/search"[^>]*data-field-name="transcriptId"/);
  });
});
