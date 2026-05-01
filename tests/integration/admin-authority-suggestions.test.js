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

  it('POST /suggestions/:id/approve approves and returns removedSiblingIds', async () => {
    // Seed an entity with two pending suggestions (target + sibling)
    const authA = await db.authoritiesAsync.create({
      authority_type: 'person', canonical_name: 'approve-target-auth',
      description: null, properties: {}, external_source: null, external_key: null
    });
    const authB = await db.authoritiesAsync.create({
      authority_type: 'person', canonical_name: 'approve-sibling-auth',
      description: null, properties: {}, external_source: null, external_key: null
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'approve-entity',
      description: null, properties: {}, authority_id: null
    });
    const targetId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId, suggested_authority_id: authA,
      confidence: 0.9, match_method: 'test', status: 'pending'
    });
    const siblingId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId, suggested_authority_id: authB,
      confidence: 0.8, match_method: 'test', status: 'pending'
    });

    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);

    const res = await agent
      .post(`/admin/knowledge/authorities/suggestions/${targetId}/approve`)
      .set('x-csrf-token', csrf)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, suggestionId: targetId, removedSiblingIds: [siblingId] });

    const target = await db.authorityLinkSuggestionsAsync.getById(targetId);
    const sibling = await db.authorityLinkSuggestionsAsync.getById(siblingId);
    expect(target.status).toBe('approved');
    expect(sibling.status).toBe('rejected');

    const entity = await db.entitiesAsync.getById(entityId);
    expect(entity.authority_id).toBe(authA);
  });

  it('POST /suggestions/:id/approve returns 404 for unknown id', async () => {
    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);
    const res = await agent
      .post('/admin/knowledge/authorities/suggestions/9999999/approve')
      .set('x-csrf-token', csrf)
      .send({});
    expect(res.status).toBe(404);
  });

  it('POST /suggestions/:id/approve returns 409 for already-reviewed suggestion', async () => {
    const { suggestionId } = await seedSuggestion(db, {
      entityName: 'already-reviewed-ent',
      authorityName: 'already-reviewed-auth',
      status: 'rejected'
    });
    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);
    const res = await agent
      .post(`/admin/knowledge/authorities/suggestions/${suggestionId}/approve`)
      .set('x-csrf-token', csrf)
      .send({});
    expect(res.status).toBe(409);
  });

  it('POST /suggestions/:id/reject rejects without touching siblings', async () => {
    const authA = await db.authoritiesAsync.create({
      authority_type: 'person', canonical_name: 'reject-a',
      description: null, properties: {}, external_source: null, external_key: null
    });
    const authB = await db.authoritiesAsync.create({
      authority_type: 'person', canonical_name: 'reject-b',
      description: null, properties: {}, external_source: null, external_key: null
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'reject-entity',
      description: null, properties: {}, authority_id: null
    });
    const targetId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId, suggested_authority_id: authA,
      confidence: 0.9, match_method: 'test', status: 'pending'
    });
    const siblingId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId, suggested_authority_id: authB,
      confidence: 0.8, match_method: 'test', status: 'pending'
    });

    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);
    const res = await agent
      .post(`/admin/knowledge/authorities/suggestions/${targetId}/reject`)
      .set('x-csrf-token', csrf)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, suggestionId: targetId });

    const target = await db.authorityLinkSuggestionsAsync.getById(targetId);
    const sibling = await db.authorityLinkSuggestionsAsync.getById(siblingId);
    expect(target.status).toBe('rejected');
    expect(sibling.status).toBe('pending');

    const entity = await db.entitiesAsync.getById(entityId);
    expect(entity.authority_id).toBeNull();
  });

  it('POST /suggestions/:id/reject returns 404 for unknown id', async () => {
    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);
    const res = await agent
      .post('/admin/knowledge/authorities/suggestions/9999998/reject')
      .set('x-csrf-token', csrf)
      .send({});
    expect(res.status).toBe(404);
  });

  it('POST /suggestions/bulk/approve approves a batch and reports collisions', async () => {
    // Two entities, each with two pending suggestions; we'll bulk-approve all 4.
    // Expectation: one wins per entity, the other is reported already_reviewed.
    const e1 = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'bulk-e1',
      description: null, properties: {}, authority_id: null
    });
    const e2 = await db.entitiesAsync.create({
      entity_type: 'person', canonical_name: 'bulk-e2',
      description: null, properties: {}, authority_id: null
    });
    const ids = [];
    for (const e of [e1, e2]) {
      for (const tag of ['x', 'y']) {
        const a = await db.authoritiesAsync.create({
          authority_type: 'person', canonical_name: `bulk-auth-${e}-${tag}`,
          description: null, properties: {}, external_source: null, external_key: null
        });
        const sid = await db.authorityLinkSuggestionsAsync.createIfMissing({
          entity_id: e, suggested_authority_id: a,
          confidence: 0.9, match_method: 'test', status: 'pending'
        });
        ids.push(sid);
      }
    }
    expect(ids.length).toBe(4);

    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);
    const res = await agent
      .post('/admin/knowledge/authorities/suggestions/bulk/approve')
      .set('x-csrf-token', csrf)
      .send({ ids });
    expect(res.status).toBe(200);

    const succeeded = res.body.results.filter(r => r.success);
    const collided  = res.body.results.filter(r => r.error === 'already_reviewed');
    expect(succeeded.length).toBe(2);
    expect(collided.length).toBe(2);
    expect(res.body.removedIds.sort()).toEqual([...ids].sort());
  });

  it('POST /suggestions/bulk/approve returns 400 when ids is empty', async () => {
    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);
    const res = await agent
      .post('/admin/knowledge/authorities/suggestions/bulk/approve')
      .set('x-csrf-token', csrf)
      .send({ ids: [] });
    expect(res.status).toBe(400);
  });

  it('POST /suggestions/bulk/approve returns 400 when ids exceeds 200', async () => {
    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);
    const tooMany = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await agent
      .post('/admin/knowledge/authorities/suggestions/bulk/approve')
      .set('x-csrf-token', csrf)
      .send({ ids: tooMany });
    expect(res.status).toBe(400);
  });

  it('POST /suggestions/bulk/reject rejects all and does not touch siblings', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const seeded = await seedSuggestion(db, {
        entityName: 'bulk-reject-ent-' + i,
        authorityName: 'bulk-reject-auth-' + i
      });
      ids.push(seeded.suggestionId);
    }

    const page = await agent.get('/admin/knowledge/authorities/suggestions');
    const csrf = extractCsrfFromMeta(page.text);
    const res = await agent
      .post('/admin/knowledge/authorities/suggestions/bulk/reject')
      .set('x-csrf-token', csrf)
      .send({ ids });
    expect(res.status).toBe(200);
    expect(res.body.results.every(r => r.success)).toBe(true);
    expect(res.body.removedIds.sort()).toEqual([...ids].sort());

    for (const id of ids) {
      const row = await db.authorityLinkSuggestionsAsync.getById(id);
      expect(row.status).toBe('rejected');
    }
  });
});
