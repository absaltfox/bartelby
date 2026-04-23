'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

let app;
let db;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function bootstrapAdmin(agent, username) {
  const setupPage = await agent.get('/setup');
  const csrf = extractCsrfToken(setupPage.text);
  await agent
    .post('/setup')
    .type('form')
    .send({
      username,
      password: 'testpassword99!',
      confirm: 'testpassword99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: csrf
    });
}

async function loginAsAdmin(agent, username) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  return agent
    .post('/login')
    .type('form')
    .send({ username, password: 'testpassword99!', _csrf: csrf });
}

beforeAll(async () => {
  jest.resetModules();
  const server = require('../../server');
  await server.initApp();
  app = server.app;
  db = require('../../database/db');

  const bootstrapAgent = request.agent(app);
  await bootstrapAdmin(bootstrapAgent, 'idoradmin');
}, 30_000);

describe('authority suggestion IDOR protection', () => {
  let agent;

  beforeEach(async () => {
    agent = request.agent(app);
    await loginAsAdmin(agent, 'idoradmin');
  });

  it('rejects approve of a suggestion via the wrong entity URL', async () => {
    // Create two unrelated entities and an authority
    const entity1Id = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'IDOR Test Entity One',
      description: null,
      properties: {}
    });
    const entity2Id = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'IDOR Test Entity Two',
      description: null,
      properties: {}
    });
    const authorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'IDOR Test Authority',
      description: null,
      properties: {}
    });

    // Create a suggestion linking entity2 -> authority (NOT entity1)
    const suggestionId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entity2Id,
      suggested_authority_id: authorityId,
      confidence: 0.9,
      match_method: 'alias',
      status: 'pending'
    });

    // Attempt to approve entity2's suggestion via entity1's URL
    const detailPage = await agent.get(`/admin/knowledge/entities/${entity1Id}`);
    const csrf = extractCsrfToken(detailPage.text);

    const res = await agent
      .post(`/admin/knowledge/entities/${entity1Id}/authority-suggestions/${suggestionId}/approve`)
      .type('form')
      .send({ _csrf: csrf });

    // Should redirect with an error, not a success
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=');
    expect(res.headers.location).not.toContain('authorityUpdated=1');

    // entity2 must NOT have had its authority_id changed
    const entity2 = await db.entitiesAsync.getById(entity2Id);
    expect(entity2.authority_id).toBeNull();
  });

  it('rejects reject of a suggestion via the wrong entity URL', async () => {
    const entity1Id = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'IDOR Reject Entity One',
      description: null,
      properties: {}
    });
    const entity2Id = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'IDOR Reject Entity Two',
      description: null,
      properties: {}
    });
    const authorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'IDOR Reject Authority',
      description: null,
      properties: {}
    });

    const suggestionId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entity2Id,
      suggested_authority_id: authorityId,
      confidence: 0.9,
      match_method: 'alias',
      status: 'pending'
    });

    const detailPage = await agent.get(`/admin/knowledge/entities/${entity1Id}`);
    const csrf = extractCsrfToken(detailPage.text);

    const res = await agent
      .post(`/admin/knowledge/entities/${entity1Id}/authority-suggestions/${suggestionId}/reject`)
      .type('form')
      .send({ _csrf: csrf });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=');
    expect(res.headers.location).not.toContain('authorityUpdated=1');

    // Suggestion must still be pending
    const suggestions = await db.authorityLinkSuggestionsAsync.getByEntityId(entity2Id);
    const suggestion = suggestions.find(s => s.id === suggestionId);
    expect(suggestion.status).toBe('pending');
  });

  it('allows approve of a suggestion via the correct entity URL', async () => {
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'IDOR Correct Entity',
      description: null,
      properties: {}
    });
    const authorityId = await db.authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: 'IDOR Correct Authority',
      description: null,
      properties: {}
    });

    const suggestionId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId,
      suggested_authority_id: authorityId,
      confidence: 0.9,
      match_method: 'alias',
      status: 'pending'
    });

    const detailPage = await agent.get(`/admin/knowledge/entities/${entityId}`);
    const csrf = extractCsrfToken(detailPage.text);

    const res = await agent
      .post(`/admin/knowledge/entities/${entityId}/authority-suggestions/${suggestionId}/approve`)
      .type('form')
      .send({ _csrf: csrf });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('authorityUpdated=1');

    const entity = await db.entitiesAsync.getById(entityId);
    expect(entity.authority_id).toBe(authorityId);
  });
});
