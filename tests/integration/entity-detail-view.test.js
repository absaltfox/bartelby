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
let entityId;

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
      username: 'viewtestadmin',
      password: 'pw-viewtest99!X',
      confirm: 'pw-viewtest99!X',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  const loginRes = await adminAgent
    .post('/login')
    .type('form')
    .send({ username: 'viewtestadmin', password: 'pw-viewtest99!X', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);

  // Seed an entity with a role property so we can assert on the meta line
  const result = await db.runAsync(
    `INSERT INTO entities (entity_type, canonical_name, properties) VALUES ('person', 'A. C. Pope', '{"role":"Superintendent of Education"}')`
  );
  entityId = result.lastInsertRowid;
}, 60_000);

describe('GET /admin/knowledge/entities/:id — redesigned view', () => {
  it('renders breadcrumbs with Knowledge and Entities crumbs', async () => {
    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="breadcrumbs"');
    expect(res.text).toContain('href="/admin/knowledge"');
    expect(res.text).toContain('href="/admin/knowledge/entities"');
    expect(res.text).toContain('A. C. Pope');
  });

  it('renders a single consequence-text line for Correct actions', async () => {
    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}`);
    expect(res.status).toBe(200);
    const consequenceMatches = res.text.match(/Edit preserves evidence/g) || [];
    expect(consequenceMatches.length).toBe(1);
    // The old correction-workspace-note wording should not appear.
    expect(res.text).not.toContain('Entity corrections are audited.');
  });

  it('renders the entity-detail layout with an end-of-record actions cluster', async () => {
    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="entity-detail"');
    expect(res.text).toContain('class="entity-detail__record-actions"');
    // Correct + Author groups both present, aria-labelledby-anchored labels.
    expect(res.text).toMatch(/id="entity-record-actions-correct">Correct/);
    expect(res.text).toMatch(/id="entity-record-actions-author">Author/);
  });

  it('places a visible Danger zone after the actions with a Delete button', async () => {
    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}`);
    expect(res.status).toBe(200);
    // Danger zone appears after the record-actions cluster and posts to /delete.
    expect(res.text).toMatch(/entity-detail__record-actions[\s\S]*?entity-detail__danger[\s\S]*?\/delete/);
    expect(res.text).toContain('Delete entity');
  });

  it('surfaces the entity meta line with type and id', async () => {
    const res = await adminAgent.get(`/admin/knowledge/entities/${entityId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="entity-meta"');
    expect(res.text).toContain('id ' + entityId);
  });
});
