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
let authorityId;

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
    username: 'chronotabadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'chronotabadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });

  const auth = await db.runAsync(`INSERT INTO authorities (authority_type, canonical_name) VALUES ('person', 'Chrono Tab Test')`);
  authorityId = auth.lastInsertRowid;
  const member = await db.runAsync(`INSERT INTO entities (entity_type, canonical_name, authority_id) VALUES ('person', 'Member X', ?)`, [authorityId]);
  await db.runAsync(`INSERT INTO date_expressions (entity_id, label, earliest, latest, precision) VALUES (?, 'birth', '1840-03-01', '1840-03-01', 'day')`,
    [member.lastInsertRowid]);
}, 60_000);

describe('GET /admin/knowledge/authorities/:id/chronology — HTML tab', () => {
  it('renders the chronology panel with sticky year header and one event', async () => {
    const res = await adminAgent.get(`/admin/knowledge/authorities/${authorityId}/chronology`).expect(200);
    expect(res.text).toContain('data-authority-chronology-panel');
    expect(res.text).toContain('1840');
    expect(res.text).toContain('birth');
    expect(res.text).toContain('Member X');
    expect(res.text).toContain('<script src="/js/authority-chronology.js"></script>');
  });

  it('honors the signalTypes filter (no relationship events render when filtered out)', async () => {
    const res = await adminAgent
      .get(`/admin/knowledge/authorities/${authorityId}/chronology?signalTypes=relationship`)
      .expect(200);
    expect(res.text).toContain('No chronology events match the current filters');
  });

  it('authority-detail page exposes a "Chronology" tab link', async () => {
    const res = await adminAgent.get(`/admin/knowledge/authorities/${authorityId}`).expect(200);
    expect(res.text).toMatch(/href="\/admin\/knowledge\/authorities\/\d+\/chronology"/);
    expect(res.text).toContain('Chronology');
  });
});
