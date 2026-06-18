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
let csrfToken;

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
    username: 'savedhladmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'savedhladmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });

  const formPage = await adminAgent.get('/admin/knowledge/vocabularies/relationship-types');
  csrfToken = extractCsrfToken(formPage.text);
}, 60_000);

describe('C4 saved-name highlight', () => {
  it('inline-edit redirect carries &savedName=<name>', async () => {
    await db.runAsync(
      `INSERT OR IGNORE INTO relationship_types (name, label, category, frequency) VALUES ('c4_saved_highlight_target', 'Saved Highlight', 'general', 'common')`
    );
    const res = await adminAgent
      .post('/admin/knowledge/vocabularies/relationship-types/c4_saved_highlight_target/edit')
      .type('form')
      .send({ _csrf: csrfToken, label: 'Saved Highlight Updated' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/savedName=c4_saved_highlight_target/);
  });

  it('subsequent render adds data-just-saved="1" on the matching row', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/vocabularies/relationship-types?tab=types&savedName=c4_saved_highlight_target')
      .expect(200);
    // Match: <tr ... data-just-saved="1" ...> ... <code>c4_saved_highlight_target</code>
    expect(res.text).toMatch(/<tr[^>]*data-just-saved="1"[^>]*>[\s\S]*?<code>c4_saved_highlight_target<\/code>/);
  });
});
