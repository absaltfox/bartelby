'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-match-method';

const request = require('supertest');

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

describe('matchMethod filter on authority-suggestions queue', () => {
  let app;
  let db;
  let agent;

  // Seeded suggestion IDs for the main filter specs
  let exactCanonicalId;
  let embeddingId;

  beforeAll(async () => {
    jest.resetModules();
    const { app: a, initApp } = require('../../server');
    await initApp();
    app = a;
    db = require('../../database/db');

    // Setup admin user
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

    // Seed: one authority, two entities, two suggestions with different match_method values
    const authorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'mm-filter-target-authority',
      description: null,
      properties: {},
      external_source: null,
      external_key: null
    });

    const entityExactId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'mm-filter-entity-exact',
      description: null,
      properties: {},
      authority_id: null
    });

    const entityEmbeddingId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'mm-filter-entity-embedding',
      description: null,
      properties: {},
      authority_id: null
    });

    exactCanonicalId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityExactId,
      suggested_authority_id: authorityId,
      confidence: 0.95,
      match_method: 'exact_canonical',
      status: 'pending'
    });

    embeddingId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityEmbeddingId,
      suggested_authority_id: authorityId,
      confidence: 0.75,
      match_method: 'embedding',
      status: 'pending'
    });
  }, 30_000);

  it('GET ?matchMethod=embedding returns only embedding suggestions', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions.json?status=pending&matchMethod=embedding&limit=100');
    expect(res.status).toBe(200);

    const ids = res.body.suggestions.map(s => s.id);
    expect(ids).toContain(embeddingId);
    expect(ids).not.toContain(exactCanonicalId);
  });

  it('GET ?matchMethod=exact_canonical,embedding returns both suggestions', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions.json?status=pending&matchMethod=exact_canonical,embedding&limit=100');
    expect(res.status).toBe(200);

    const ids = res.body.suggestions.map(s => s.id);
    expect(ids).toContain(embeddingId);
    expect(ids).toContain(exactCanonicalId);
  });

  it('GET ?nameSignal=exact (legacy) maps to exact_canonical and returns only exact_canonical rows', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions.json?status=pending&nameSignal=exact&limit=100');
    expect(res.status).toBe(200);

    const ids = res.body.suggestions.map(s => s.id);
    expect(ids).toContain(exactCanonicalId);
    expect(ids).not.toContain(embeddingId);
  });

  it('GET with no filter returns both suggestions', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions.json?status=pending&limit=100');
    expect(res.status).toBe(200);

    const ids = res.body.suggestions.map(s => s.id);
    expect(ids).toContain(embeddingId);
    expect(ids).toContain(exactCanonicalId);
  });

  it('GET /suggestions HTML includes chip-list with matchMethod links for each known method', async () => {
    const res = await agent
      .get('/admin/knowledge/authorities/suggestions?status=pending');
    expect(res.status).toBe(200);

    // The chip-list div must be present
    expect(res.text).toContain('filter-chips');

    // Each known method should appear as a link in the chips
    expect(res.text).toContain('matchMethod=exact_canonical');
    expect(res.text).toContain('matchMethod=embedding');
    expect(res.text).toContain('matchMethod=fuzzy_canonical');
    expect(res.text).toContain('matchMethod=member_exact');
  });
});
