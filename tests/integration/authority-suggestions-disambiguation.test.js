'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-disambiguation';

const request = require('supertest');

function extractCsrfFromForm(html) {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

function extractCsrfFromMeta(html) {
  const m = html.match(/name="csrf-token"\s+content="([^"]+)"/);
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

// Seed a grouped entity (3 suggestions) + a single-suggestion entity.
// Returns { groupedEntityId, authorityIds: [a, b, c], singleEntityId, singleAuthorityId }
async function seedDisambiguationFixture(db) {
  // Grouped entity: "Wm. Jessop" with 3 candidate authorities
  const groupedEntityId = await db.entitiesAsync.create({
    entity_type: 'person',
    canonical_name: 'Wm. Jessop',
    description: null,
    properties: {},
    authority_id: null
  });

  const authA = await db.authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: 'John Jessop A',
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });
  const authB = await db.authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: 'John Jessop B',
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });
  const authC = await db.authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: 'John Jessop C',
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });

  await db.authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: groupedEntityId,
    suggested_authority_id: authA,
    confidence: 0.9,
    match_method: 'embedding',
    status: 'pending'
  });
  await db.authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: groupedEntityId,
    suggested_authority_id: authB,
    confidence: 0.8,
    match_method: 'embedding',
    status: 'pending'
  });
  await db.authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: groupedEntityId,
    suggested_authority_id: authC,
    confidence: 0.7,
    match_method: 'embedding',
    status: 'pending'
  });

  // Single entity: control for the non-grouped path
  const singleEntityId = await db.entitiesAsync.create({
    entity_type: 'person',
    canonical_name: 'Single Entity Control',
    description: null,
    properties: {},
    authority_id: null
  });
  const singleAuth = await db.authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: 'Single Control Authority',
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });
  await db.authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: singleEntityId,
    suggested_authority_id: singleAuth,
    confidence: 0.85,
    match_method: 'exact_canonical',
    status: 'pending'
  });

  return {
    groupedEntityId,
    authorityIds: [authA, authB, authC],
    singleEntityId,
    singleAuthorityId: singleAuth
  };
}

describe('Disambiguation grouping backend (U3.1, U3.3, U3.4)', () => {
  let app;
  let db;
  let agent;

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
  }, 30_000);

  it('GET /suggestions?status=pending includes grouped entity and all candidate authority names', async () => {
    const { groupedEntityId, authorityIds } = await seedDisambiguationFixture(db);

    const res = await agent.get('/admin/knowledge/authorities/suggestions?status=pending');
    expect(res.status).toBe(200);

    // The grouped entity name must appear
    expect(res.text).toContain('Wm. Jessop');
    // Each candidate authority name must appear
    expect(res.text).toContain('John Jessop A');
    expect(res.text).toContain('John Jessop B');
    expect(res.text).toContain('John Jessop C');
    // The single-suggestion entity must also appear
    expect(res.text).toContain('Single Entity Control');
  });

  it('POST .../disambiguation/:entityId/approve approves chosen authority and cascade-rejects siblings', async () => {
    const { groupedEntityId, authorityIds: [authA, authB, authC] } = await seedDisambiguationFixture(db);

    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);

    const res = await agent
      .post(`/admin/knowledge/authorities/suggestions/disambiguation/${groupedEntityId}/approve`)
      .set('x-csrf-token', csrf)
      .set('Content-Type', 'application/json')
      .send({ authorityId: authA });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify DB state
    const allSuggestions = await db.authorityLinkSuggestionsAsync.list('all', 100, {
      entityId: groupedEntityId,
      includeAlreadyLinked: true
    });

    const byAuthority = Object.fromEntries(
      allSuggestions.map(s => [s.suggested_authority_id, s.status])
    );
    expect(byAuthority[authA]).toBe('approved');
    expect(byAuthority[authB]).toBe('rejected');
    expect(byAuthority[authC]).toBe('rejected');

    // Entity must be linked to authA
    const entity = await db.entitiesAsync.getById(groupedEntityId);
    expect(Number(entity.authority_id)).toBe(authA);
  });

  it('POST .../disambiguation/:entityId/new-authority rejects all suggestions and creates a new authority', async () => {
    const { groupedEntityId, authorityIds: [authA, authB, authC] } = await seedDisambiguationFixture(db);

    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);

    const res = await agent
      .post(`/admin/knowledge/authorities/suggestions/disambiguation/${groupedEntityId}/new-authority`)
      .set('x-csrf-token', csrf)
      .set('Content-Type', 'application/json')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Number.isInteger(res.body.authorityId)).toBe(true);
    expect(res.body.authorityId).toBeGreaterThan(0);

    const newAuthorityId = res.body.authorityId;

    // All suggestions should be rejected
    const allSuggestions = await db.authorityLinkSuggestionsAsync.list('all', 100, {
      entityId: groupedEntityId,
      includeAlreadyLinked: true
    });
    for (const s of allSuggestions) {
      expect(s.status).toBe('rejected');
    }

    // New authority must exist with matching type + canonical_name
    const newAuthority = await db.authoritiesAsync.getById(newAuthorityId);
    expect(newAuthority).toBeTruthy();
    expect(newAuthority.canonical_name).toBe('Wm. Jessop');
    expect(newAuthority.authority_type).toBe('person');

    // Entity must be linked to the new authority
    const entity = await db.entitiesAsync.getById(groupedEntityId);
    expect(Number(entity.authority_id)).toBe(newAuthorityId);
  });
});
