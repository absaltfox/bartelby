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
  await setupAgent.post('/setup').type('form').send({
    username: 'authmemberadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 'authmemberadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });
}, 60_000);

describe('authority-detail relationship-creation member picker', () => {
  it('renders one <a> per member, each linking to relationships/new?sourceEntityId=<id>', async () => {
    const authority = await db.runAsync(
      `INSERT INTO authorities (authority_type, canonical_name) VALUES ('person', 'Auth Member Test')`
    );
    const authorityId = authority.lastInsertRowid;

    const memberA = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name, authority_id) VALUES ('person', 'Member Alpha', ?)`,
      [authorityId]
    );
    const memberB = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name, authority_id) VALUES ('person', 'Member Bravo', ?)`,
      [authorityId]
    );

    const res = await adminAgent.get(`/admin/knowledge/authorities/${authorityId}`).expect(200);

    expect(res.text).toContain('data-authority-relationship-members');
    expect(res.text).toMatch(new RegExp('href="/admin/knowledge/relationships/new\\?sourceEntityId=' + memberA.lastInsertRowid + '"'));
    expect(res.text).toMatch(new RegExp('href="/admin/knowledge/relationships/new\\?sourceEntityId=' + memberB.lastInsertRowid + '"'));
    expect(res.text).toContain('Member Alpha');
    expect(res.text).toContain('Member Bravo');
  });
});
