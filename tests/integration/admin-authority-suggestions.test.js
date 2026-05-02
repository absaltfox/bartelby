'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');
const fs = require('fs');
const path = require('path');

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

async function seedSuggestion(db, { entityName, authorityName, status = 'pending', confidence = 0.85, matchMethod = 'test' }) {
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
    confidence, match_method: matchMethod, status
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

  it('GET /suggestions.json reports exact names without changing embedding confidence', async () => {
    const { suggestionId } = await seedSuggestion(db, {
      entityName: 'Canadian Pacific Railway Company',
      authorityName: 'Canadian Pacific Railway Company',
      confidence: 0.83,
      matchMethod: 'embedding'
    });

    const res = await agent
      .get('/admin/knowledge/authorities/suggestions.json?status=pending&limit=100');
    expect(res.status).toBe(200);

    const row = res.body.suggestions.find(s => s.id === suggestionId);
    expect(row).toBeTruthy();
    expect(row.confidence).toBe(0.83);
    expect(row.confidence_label).toBe('Confidence 83%');
    expect(row.match_method).toBe('embedding');
    expect(row.match_method_label).toBe('Method: embedding');
    expect(row.exact_name_match).toBe(true);
  });

  it('authority suggestion list can include compact review context when requested', async () => {
    const suggestedAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'organization', canonical_name: 'Context Review Authority',
      description: null, properties: {}, external_source: null, external_key: null
    });
    const currentAuthorityId = await db.authoritiesAsync.create({
      authority_type: 'organization', canonical_name: 'Current Context Authority',
      description: null, properties: {}, external_source: null, external_key: null
    });
    const entityId = await db.entitiesAsync.create({
      entity_type: 'organization', canonical_name: 'Context Review Entity',
      description: null, properties: {}, authority_id: currentAuthorityId
    });
    const memberId = await db.entitiesAsync.create({
      entity_type: 'organization', canonical_name: 'Context Review Member',
      description: null, properties: {}, authority_id: suggestedAuthorityId
    });
    const documentId = await db.documentsAsync.create({
      title: 'Authority Suggestion Context Doc',
      date_created: '1901-01-01',
      description: null,
      image_path: '/uploads/context-doc.png',
      metadata: {}
    });
    const transcriptId = await db.transcriptsAsync.create({
      document_id: documentId,
      content: 'Context Review Entity appears with supporting authority evidence.',
      transcriber: 'Test',
      version: 1,
      notes: null,
      is_best: true
    });
    await db.citationsAsync.create({
      entity_id: entityId,
      relationship_id: null,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 0,
      passage_end: 59,
      passage_text: 'Context Review Entity appears with supporting authority evidence.',
      extraction_method: 'test',
      extraction_model: 'jest',
      confidence: 1,
      approval_status: 'approved',
      approval_method: 'manual'
    });
    await db.citationsAsync.create({
      entity_id: memberId,
      relationship_id: null,
      transcript_id: transcriptId,
      document_id: documentId,
      passage_start: 0,
      passage_end: 21,
      passage_text: 'Context Review Member',
      extraction_method: 'test',
      extraction_model: 'jest',
      confidence: 1,
      approval_status: 'approved',
      approval_method: 'manual'
    });
    const suggestionId = await db.authorityLinkSuggestionsAsync.createIfMissing({
      entity_id: entityId,
      suggested_authority_id: suggestedAuthorityId,
      confidence: 0.82,
      match_method: 'embedding',
      status: 'pending'
    });

    const rows = await db.authorityLinkSuggestionsAsync.list('pending', 100, {
      includeContext: true
    });

    const row = rows.find(s => s.id === suggestionId);
    expect(row).toBeTruthy();
    expect(row.source_document_title).toBe('Authority Suggestion Context Doc');
    expect(row.source_evidence_text).toContain('supporting authority evidence');
    expect(row.suggested_authority_member_count).toBe(1);
    expect(row.suggested_authority_document_count).toBe(1);
    expect(row.current_authority_name).toBe('Current Context Authority');

    const contextRes = await agent
      .get(`/admin/knowledge/authorities/suggestions/context.json?ids=${suggestionId}`);
    expect(contextRes.status).toBe(200);
    const contextRow = contextRes.body.suggestions.find(s => s.id === suggestionId);
    expect(contextRow).toBeTruthy();
    expect(contextRow.source_context_pending).toBe(false);
    expect(contextRow.source_document_label).toBe('Authority Suggestion Context Doc');
    expect(contextRow.source_evidence_excerpt).toContain('supporting authority evidence');
    expect(contextRow.suggested_authority_stats_label).toBe('1 member, 1 document');
  });

  it('GET /suggestions.json?nameSignal=exact returns only exact-name suggestions', async () => {
    const exact = await seedSuggestion(db, {
      entityName: 'exact-filter-railway',
      authorityName: ' exact-filter-railway ',
      confidence: 0.83,
      matchMethod: 'embedding'
    });
    const fuzzy = await seedSuggestion(db, {
      entityName: 'exact-filter-school district',
      authorityName: 'exact-filter-hope school district',
      confidence: 0.88,
      matchMethod: 'embedding'
    });

    const res = await agent
      .get('/admin/knowledge/authorities/suggestions.json?status=pending&nameSignal=exact&limit=100');
    expect(res.status).toBe(200);

    const ids = res.body.suggestions.map(s => s.id);
    expect(ids).toContain(exact.suggestionId);
    expect(ids).not.toContain(fuzzy.suggestionId);

    const row = res.body.suggestions.find(s => s.id === exact.suggestionId);
    expect(row.confidence).toBe(0.83);
    expect(row.confidence_label).toBe('Confidence 83%');
    expect(row.match_method).toBe('embedding');
    expect(row.match_method_label).toBe('Method: embedding');
    expect(row.exact_name_match).toBe(true);
  });

  it('GET /suggestions.json orders exact-name pending suggestions first by default', async () => {
    const exact = await seedSuggestion(db, {
      entityName: 'order-test-authority',
      authorityName: 'order-test-authority',
      confidence: 0.76,
      matchMethod: 'embedding'
    });
    const fuzzy = await seedSuggestion(db, {
      entityName: 'order-test-authority',
      authorityName: 'order-test-authority branch',
      confidence: 0.91,
      matchMethod: 'embedding'
    });

    const res = await agent
      .get('/admin/knowledge/authorities/suggestions.json?status=pending&limit=100');
    expect(res.status).toBe(200);

    const ids = res.body.suggestions.map(s => s.id);
    expect(ids.indexOf(exact.suggestionId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(fuzzy.suggestionId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(exact.suggestionId)).toBeLessThan(ids.indexOf(fuzzy.suggestionId));
  });

  it('GET /suggestions renders exact-name fast-lane controls and labels', async () => {
    await seedSuggestion(db, {
      entityName: 'render-exact-authority',
      authorityName: 'render-exact-authority',
      confidence: 0.83,
      matchMethod: 'embedding'
    });

    const res = await agent.get('/admin/knowledge/authorities/suggestions?status=pending');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Exact names');
    expect(res.text).toContain('Select exact names on page');
    expect(res.text).toContain('authority-suggestion-bulk-bar');
    expect(res.text).toContain('authority-suggestion-card');
    expect(res.text).toContain('data-context-pending="1"');
    expect(res.text).toContain('skeleton-line');
    expect(res.text).toContain('Evidence');
    expect(res.text).toContain('Suggested authority');
    expect(res.text).toContain('Exact name');
    expect(res.text).toContain('Confidence 83%');
    expect(res.text).toContain('Method: embedding');
  });

  it('client renderCard includes polished sections and exact-name selection data', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../../public/js/admin-authority-suggestions.js'),
      'utf8'
    );
    expect(script).toContain('authority-suggestion-card');
    expect(script).toContain('authority-suggestion-context');
    expect(script).toContain('authority-suggestion-meta-note');
    expect(script).toContain('data-exact-name-match');
    expect(script).toContain('data-context-pending');
    expect(script).toContain('skeleton-line');
    expect(script).toContain('suggestions/context.json');
    expect(script).toContain('Method: ');
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
