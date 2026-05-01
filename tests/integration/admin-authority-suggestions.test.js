'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

function extractCsrfFromMeta(html) {
  const m = html.match(/name="csrf-token"\s+content="([^"]+)"/);
  return m ? m[1] : null;
}

function extractCsrfFromForm(html) {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

async function loginAsAdmin(agent) {
  const page = await agent.get('/login');
  const csrf = extractCsrfFromForm(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username: 'testadmin', password: 'testpassword99!', _csrf: csrf });
  expect(res.status).toBe(302);
}

async function seedSuggestion(db, { entityName, authorityName, status = 'pending' }) {
  const authorityId = await db.authoritiesAsync.create({
    authority_type: 'person', canonical_name: authorityName,
    description: null, properties: {}, external_source: null, external_key: null
  });
  const entityId = await db.entitiesAsync.create({
    entity_type: 'person', canonical_name: entityName,
    description: null, properties: {}, authority_id: null
  });
  const suggestionId = await db.authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: entityId, suggested_authority_id: authorityId,
    confidence: 0.85, match_method: 'test', status
  });
  return { entityId, authorityId, suggestionId };
}

describe('admin authority suggestions AJAX', () => {
  let app;
  let db;
  let agent;

  beforeAll(async () => {
    jest.resetModules();
    const { app: a, initApp } = require('../../server');
    await initApp();
    app = a;
    db = require('../../database/db');

    const setupAgent = request.agent(app);
    const setupPage = await setupAgent.get('/setup');
    const setupCsrf = extractCsrfFromForm(setupPage.text);
    await setupAgent
      .post('/setup')
      .type('form')
      .send({
        username: 'testadmin',
        password: 'testpassword99!',
        confirm: 'testpassword99!',
        bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
        _csrf: setupCsrf
      });

    agent = request.agent(app);
    await loginAsAdmin(agent);
  }, 30_000);

  it('GET /suggestions.json returns first page + cursor; cursor returns next page', async () => {
    // Seed 5 pending suggestions
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(await seedSuggestion(db, {
        entityName: 'json-list-ent-' + i,
        authorityName: 'json-list-auth-' + i
      }));
    }

    const first = await agent
      .get('/admin/knowledge/authorities/suggestions.json?status=pending&limit=2');
    expect(first.status).toBe(200);
    expect(first.body.suggestions.length).toBe(2);
    expect(first.body.nextCursor).toBeTruthy();

    const c = first.body.nextCursor;
    const second = await agent
      .get(`/admin/knowledge/authorities/suggestions.json?status=pending&limit=2&beforeCreatedAt=${encodeURIComponent(c.beforeCreatedAt)}&beforeId=${c.beforeId}`);
    expect(second.status).toBe(200);
    expect(second.body.suggestions.length).toBe(2);

    const firstIds = first.body.suggestions.map(r => r.id);
    const secondIds = second.body.suggestions.map(r => r.id);
    for (const id of secondIds) expect(firstIds).not.toContain(id);
  });
});
