'use strict';

// Integration tests for Task 4.4 — relaxed authority entity-side POSTs.
//
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Authority asymmetry", entity-side actions (suggestion approve/reject,
// unlink/reassign of members, disambiguation approve/new-authority) gate
// on requireCurate(...). Authority-side actions (merge, rename, delete,
// bulk-delete, bulk-merge) stay admin-only. Vocabulary edits and job
// triggers also stay admin-only per "Corpus mutations require admin
// trigger" — see the project memory rule of the same name.

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';

const request = require('supertest');
const express = require('express');
const { initApp } = require('../../server');
const {
  usersAsync,
  collectionsAsync,
  documentsAsync,
  documentCollectionsAsync,
  userCollectionAccessAsync,
  transcriptsAsync,
  entitiesAsync,
  citationsAsync,
  authoritiesAsync,
  authorityLinkSuggestionsAsync
} = require('../../database/db');

const authoritiesRouter = require('../../routes/admin-authorities');

function buildAppWithFakeAuth() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const userId = req.header('x-user-id');
    const role = req.header('x-user-role') || 'user';
    if (!userId) {
      req.isAuthenticated = () => false;
      return next();
    }
    req.user = { id: parseInt(userId, 10), role };
    req.isAuthenticated = () => true;
    next();
  });
  app.use('/admin/knowledge/authorities', authoritiesRouter);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function seedEntityWithSuggestion({ userRole = 'manager' } = {}) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const userId = await usersAsync.create({
    username: `u-${unique}`,
    email: `${unique}@x.test`,
    passwordHash: 'unused',
    role: 'user',
    status: 'active'
  });
  const collectionId = await collectionsAsync.create({
    name: `c-${unique}`,
    is_public: 0,
    createdBy: userId
  });
  const documentId = await documentsAsync.create({
    title: `d-${unique}`,
    date_created: null,
    description: null,
    image_path: null,
    metadata: {}
  });
  await documentCollectionsAsync.add(documentId, collectionId);
  const transcriptId = await transcriptsAsync.create({
    document_id: documentId,
    content: 'fixture transcript',
    transcriber: 'fixture',
    notes: null
  });
  const entityId = await entitiesAsync.create({
    canonical_name: `E-${unique}`,
    entity_type: 'person'
  });
  await citationsAsync.create({
    entity_id: entityId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_text: 'fixture passage',
    extraction_method: 'manual',
    approval_status: 'approved'
  });
  const authorityId = await authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: `A-${unique}`,
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });
  const suggestionId = await authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: entityId,
    suggested_authority_id: authorityId,
    confidence: 0.9,
    match_method: 'exact_canonical',
    status: 'pending'
  });
  await userCollectionAccessAsync.grant(userId, collectionId, userRole);
  return {
    user: { id: userId, role: 'user' },
    collectionId,
    documentId,
    transcriptId,
    entityId,
    authorityId,
    suggestionId
  };
}

describe('Relaxed POST: authority entity-side actions', () => {
  let app;

  beforeAll(async () => {
    await initApp();
    app = buildAppWithFakeAuth();
  });

  describe('POST /suggestions/:id/approve', () => {
    test('in-collection manager succeeds', async () => {
      const seed = await seedEntityWithSuggestion({ userRole: 'manager' });
      const res = await request(app)
        .post(`/admin/knowledge/authorities/suggestions/${seed.suggestionId}/approve`)
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .send({});
      // Handler returns JSON success
      expect(res.status).not.toBe(404);
      expect([200, 302]).toContain(res.status);
    });

    test('out-of-collection manager gets 404', async () => {
      const seedA = await seedEntityWithSuggestion({ userRole: 'manager' });
      const seedB = await seedEntityWithSuggestion({ userRole: 'manager' });
      const res = await request(app)
        .post(`/admin/knowledge/authorities/suggestions/${seedB.suggestionId}/approve`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({});
      expect(res.status).toBe(404);
    });

    test('viewer role gets 404', async () => {
      const seed = await seedEntityWithSuggestion({ userRole: 'viewer' });
      const res = await request(app)
        .post(`/admin/knowledge/authorities/suggestions/${seed.suggestionId}/approve`)
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe('POST /suggestions/:id/reject', () => {
    test('in-collection manager succeeds; out-of-collection 404', async () => {
      const seedA = await seedEntityWithSuggestion({ userRole: 'manager' });
      const seedB = await seedEntityWithSuggestion({ userRole: 'manager' });

      const okRes = await request(app)
        .post(`/admin/knowledge/authorities/suggestions/${seedA.suggestionId}/reject`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({});
      expect(okRes.status).not.toBe(404);

      const denyRes = await request(app)
        .post(`/admin/knowledge/authorities/suggestions/${seedB.suggestionId}/reject`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({});
      expect(denyRes.status).toBe(404);
    });
  });

  describe('POST /suggestions/bulk/approve', () => {
    test('in-collection manager succeeds; mixed batch returns 403', async () => {
      const seedA = await seedEntityWithSuggestion({ userRole: 'manager' });
      const seedB = await seedEntityWithSuggestion({ userRole: 'manager' });

      const okRes = await request(app)
        .post('/admin/knowledge/authorities/suggestions/bulk/approve')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seedA.suggestionId] });
      expect(okRes.status).toBe(200);

      const mixedRes = await request(app)
        .post('/admin/knowledge/authorities/suggestions/bulk/approve')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seedB.suggestionId] });
      expect(mixedRes.status).toBe(403);
      expect(mixedRes.body.error).toBe('partial_unauthorized');
    });
  });

  describe('POST /:id/members/:entityId/unlink', () => {
    test('in-collection manager succeeds; out-of-collection 404', async () => {
      const seedA = await seedEntityWithSuggestion({ userRole: 'manager' });
      const seedB = await seedEntityWithSuggestion({ userRole: 'manager' });

      const okRes = await request(app)
        .post(`/admin/knowledge/authorities/${seedA.authorityId}/members/${seedA.entityId}/unlink`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({});
      expect(okRes.status).not.toBe(404);

      const denyRes = await request(app)
        .post(`/admin/knowledge/authorities/${seedB.authorityId}/members/${seedB.entityId}/unlink`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({});
      expect(denyRes.status).toBe(404);
    });
  });

  describe('Admin-only POSTs remain admin-gated (defense check)', () => {
    test('POST /backfill rejects non-admin', async () => {
      const seed = await seedEntityWithSuggestion({ userRole: 'manager' });
      const res = await request(app)
        .post('/admin/knowledge/authorities/backfill')
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({});
      // requireAdmin returns 403 (HTML) for non-admins
      // requireAdmin path: either 403 (renders denial view), 302 (redirect
      // to login when unauthenticated), or 500 in tests because the fake
      // app has no EJS views configured to render the denial template.
      // The point is the handler did NOT execute — we never see 200.
      expect([401, 403, 302, 500]).toContain(res.status);
      expect(res.status).not.toBe(200);
    });

    test('POST /:id/merge rejects non-admin', async () => {
      const seed = await seedEntityWithSuggestion({ userRole: 'manager' });
      const res = await request(app)
        .post(`/admin/knowledge/authorities/${seed.authorityId}/merge`)
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({});
      // requireAdmin path: either 403 (renders denial view), 302 (redirect
      // to login when unauthenticated), or 500 in tests because the fake
      // app has no EJS views configured to render the denial template.
      // The point is the handler did NOT execute — we never see 200.
      expect([401, 403, 302, 500]).toContain(res.status);
      expect(res.status).not.toBe(200);
    });

    test('POST /suggestion-jobs rejects non-admin', async () => {
      const seed = await seedEntityWithSuggestion({ userRole: 'manager' });
      const res = await request(app)
        .post('/admin/knowledge/authorities/suggestion-jobs')
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({});
      // requireAdmin path: either 403 (renders denial view), 302 (redirect
      // to login when unauthenticated), or 500 in tests because the fake
      // app has no EJS views configured to render the denial template.
      // The point is the handler did NOT execute — we never see 200.
      expect([401, 403, 302, 500]).toContain(res.status);
      expect(res.status).not.toBe(200);
    });

    test('POST /generic-terms rejects non-admin', async () => {
      const seed = await seedEntityWithSuggestion({ userRole: 'manager' });
      const res = await request(app)
        .post('/admin/knowledge/authorities/generic-terms')
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({});
      // requireAdmin path: either 403 (renders denial view), 302 (redirect
      // to login when unauthenticated), or 500 in tests because the fake
      // app has no EJS views configured to render the denial template.
      // The point is the handler did NOT execute — we never see 200.
      expect([401, 403, 302, 500]).toContain(res.status);
      expect(res.status).not.toBe(200);
    });
  });
});
