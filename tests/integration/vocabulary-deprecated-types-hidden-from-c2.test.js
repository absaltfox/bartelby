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

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await setupAgent
    .post('/setup')
    .type('form')
    .send({
      username: 'c4c2admin',
      password: 'pw-abcdefgh99!',
      confirm: 'pw-abcdefgh99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  const loginRes = await adminAgent
    .post('/login')
    .type('form')
    .send({ username: 'c4c2admin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('C4 deprecation hides type from C2 authoring dropdown', () => {
  it('an active type appears; a deprecated type does not', async () => {
    await db.runAsync(`INSERT OR IGNORE INTO relationship_types (name, label, category, frequency) VALUES ('c4_c2_active', 'C4 C2 Active', 'general', 'common')`);
    await db.runAsync(`INSERT OR IGNORE INTO relationship_types (name, label, category, frequency, deprecated_at) VALUES ('c4_c2_deprecated', 'C4 C2 Deprecated', 'general', 'common', CURRENT_TIMESTAMP)`);

    const res = await adminAgent.get('/admin/knowledge/relationships/new');
    expect(res.status).toBe(200);
    expect(res.text).toContain('c4_c2_active');
    expect(res.text).not.toContain('c4_c2_deprecated');
  });
});
