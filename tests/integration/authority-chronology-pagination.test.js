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
    username: 'chronopagadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'chronopagadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });

  const auth = await db.runAsync(`INSERT INTO authorities (authority_type, canonical_name) VALUES ('person', 'Pag Test')`);
  authorityId = auth.lastInsertRowid;
  const member = await db.runAsync(`INSERT INTO entities (entity_type, canonical_name, authority_id) VALUES ('person', 'Pag Member', ?)`, [authorityId]);
  const memberId = member.lastInsertRowid;
  for (let i = 0; i < 5; i++) {
    await db.runAsync(`INSERT INTO date_expressions (entity_id, label, earliest, latest, precision) VALUES (?, ?, ?, ?, 'year')`,
      [memberId, 'event ' + i, `${1870 + i}-01-01`, `${1870 + i}-12-31`]);
  }
}, 60_000);

describe('GET /admin/knowledge/authorities/:id/chronology.json — cursor pagination', () => {
  it('returns events ordered by sortDate ASC with a nextCursor', async () => {
    const res = await adminAgent.get(`/admin/knowledge/authorities/${authorityId}/chronology.json?limit=3`).expect(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBe(3);
    expect(res.body.events[0].sortDate).toBe('1870-01-01');
    expect(res.body.events[2].sortDate).toBe('1872-01-01');
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('subsequent page picks up after the cursor with no overlap', async () => {
    const page1 = (await adminAgent.get(`/admin/knowledge/authorities/${authorityId}/chronology.json?limit=3`)).body;
    const page2 = (await adminAgent.get(`/admin/knowledge/authorities/${authorityId}/chronology.json?limit=3&cursor=${encodeURIComponent(page1.nextCursor)}`)).body;
    const idsPage1 = page1.events.map((e) => `${e.kind}:${e.id}`);
    const idsPage2 = page2.events.map((e) => `${e.kind}:${e.id}`);
    expect(idsPage1.some((id) => idsPage2.includes(id))).toBe(false);
    expect(page2.events[0].sortDate).toBe('1873-01-01');
  });

  it('returns null nextCursor when exhausted', async () => {
    const all = (await adminAgent.get(`/admin/knowledge/authorities/${authorityId}/chronology.json?limit=100`)).body;
    expect(all.events.length).toBeGreaterThanOrEqual(5);
    expect(all.nextCursor).toBeNull();
  });
});
