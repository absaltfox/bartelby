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
      username: 'entityadmin',
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
    .send({ username: 'entityadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('entity-detail Create New Authority button visibility (U8.1)', () => {
  it('spec 1: Create New Authority button is visible when entity.authority_id is NULL', async () => {
    // Insert an entity without authority_id
    const entity = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Unlinked Entity')`
    );
    const entityId = entity.lastInsertRowid;

    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}`);
    expect(res.status).toBe(200);

    // Button text should be present
    expect(res.text).toContain('Create Authority');
  });

  it('spec 2: Create New Authority button is hidden when entity.authority_id is set', async () => {
    // Insert an authority
    const authority = await db.runAsync(
      `INSERT INTO authorities (authority_type, canonical_name) VALUES ('person', 'Test Authority')`
    );
    const authorityId = authority.lastInsertRowid;

    // Insert an entity WITH authority_id set
    const entity = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name, authority_id) VALUES ('person', 'Linked Entity', ?)`,
      [authorityId]
    );
    const entityId = entity.lastInsertRowid;

    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}`);
    expect(res.status).toBe(200);

    // Button text should NOT be present
    expect(res.text).not.toContain('Create Authority');
    expect(res.text).not.toContain('Create New Authority');
  });
});
