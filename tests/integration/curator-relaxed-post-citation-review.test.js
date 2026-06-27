'use strict';

// Integration test for Task 4.1 — relaxed citation review POST endpoints.
//
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Relaxed POST endpoints (explicit enumeration)", these handlers
// previously sat behind the router-wide requireAdmin and now opt in to
// requireCurate('citation', ...) so a non-admin manager whose role
// applies to a collection containing the citation can act on it.
//
// Every relaxed endpoint must pass the four-case matrix per the plan:
//   1. Admin succeeds (no behavior change)
//   2. In-collection manager succeeds (NEW)
//   3. Out-of-collection manager gets 404 (NEW)
//   4. Viewer role gets 404 (NEW)
//
// The mount strategy is the buildAppWithFakeAuth pattern from
// curator-action-permissions.test.js — we mount the real router and inject
// req.user via headers. CSRF is enforced at the server level and is
// orthogonal to the gate-swap; the predicate is the security surface here.

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
  citationsAsync
} = require('../../database/db');

const reviewRouter = require('../../routes/admin-review');

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
  app.use('/admin/knowledge', reviewRouter);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function seedPendingCitation({ userRole = 'manager' } = {}) {
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
  const citationId = await citationsAsync.create({
    entity_id: entityId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_text: 'fixture passage',
    extraction_method: 'manual',
    approval_status: 'pending'
  });
  await userCollectionAccessAsync.grant(userId, collectionId, userRole);
  return {
    user: { id: userId, role: 'user' },
    collectionId,
    documentId,
    transcriptId,
    entityId,
    citationId
  };
}

describe('Relaxed POST: citation review endpoints', () => {
  let app;
  let adminUserId;

  beforeAll(async () => {
    await initApp();
    app = buildAppWithFakeAuth();
    // Reuse any existing admin id; tests only need req.user.id to be present
    adminUserId = 1;
  });

  describe('POST /admin/knowledge/review-extractions/:id/confirm', () => {
    test('admin succeeds', async () => {
      const seed = await seedPendingCitation();
      const res = await request(app)
        .post(`/admin/knowledge/review-extractions/${seed.citationId}/confirm`)
        .set('x-user-id', String(adminUserId))
        .set('x-user-role', 'admin')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      // Handler issues a redirect after approval
      expect([200, 302]).toContain(res.status);
    });

    test('in-collection manager succeeds', async () => {
      const seed = await seedPendingCitation({ userRole: 'manager' });
      const res = await request(app)
        .post(`/admin/knowledge/review-extractions/${seed.citationId}/confirm`)
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      expect([200, 302]).toContain(res.status);
    });

    test('out-of-collection manager gets 404', async () => {
      const seedA = await seedPendingCitation({ userRole: 'manager' });
      const seedB = await seedPendingCitation({ userRole: 'manager' });
      // user from collection A acts on citation in collection B
      const res = await request(app)
        .post(`/admin/knowledge/review-extractions/${seedB.citationId}/confirm`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      expect(res.status).toBe(404);
    });

    test('viewer role gets 404', async () => {
      const seed = await seedPendingCitation({ userRole: 'viewer' });
      const res = await request(app)
        .post(`/admin/knowledge/review-extractions/${seed.citationId}/confirm`)
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /admin/knowledge/review-extractions/:id/reject', () => {
    test('in-collection manager succeeds, out-of-collection manager 404, viewer 404', async () => {
      const seedA = await seedPendingCitation({ userRole: 'manager' });
      const seedB = await seedPendingCitation({ userRole: 'manager' });
      const seedV = await seedPendingCitation({ userRole: 'viewer' });

      const okRes = await request(app)
        .post(`/admin/knowledge/review-extractions/${seedA.citationId}/reject`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      expect([200, 302]).toContain(okRes.status);

      const denyRes = await request(app)
        .post(`/admin/knowledge/review-extractions/${seedB.citationId}/reject`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      expect(denyRes.status).toBe(404);

      const viewerRes = await request(app)
        .post(`/admin/knowledge/review-extractions/${seedV.citationId}/reject`)
        .set('x-user-id', String(seedV.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      expect(viewerRes.status).toBe(404);
    });
  });

  describe('POST /admin/knowledge/review-extractions/:id/delete', () => {
    test('in-collection manager succeeds, out-of-collection manager 404', async () => {
      const seedA = await seedPendingCitation({ userRole: 'manager' });
      const seedB = await seedPendingCitation({ userRole: 'manager' });
      const okRes = await request(app)
        .post(`/admin/knowledge/review-extractions/${seedA.citationId}/delete`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      expect([200, 302]).toContain(okRes.status);

      const denyRes = await request(app)
        .post(`/admin/knowledge/review-extractions/${seedB.citationId}/delete`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ status: 'pending', page: '1', kind: 'all' });
      expect(denyRes.status).toBe(404);
    });
  });

  describe('POST /admin/knowledge/review-extractions/bulk/approve', () => {
    test('in-collection manager with all permitted ids succeeds', async () => {
      const seed = await seedPendingCitation({ userRole: 'manager' });
      const res = await request(app)
        .post('/admin/knowledge/review-extractions/bulk/approve')
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seed.citationId] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('mixed batch returns 403 partial_unauthorized', async () => {
      const seedA = await seedPendingCitation({ userRole: 'manager' });
      const seedB = await seedPendingCitation({ userRole: 'manager' });
      const res = await request(app)
        .post('/admin/knowledge/review-extractions/bulk/approve')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seedA.citationId, seedB.citationId] });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('partial_unauthorized');
      expect(res.body.unauthorizedIds).toContain(seedB.citationId);
    });

    test('viewer role gets 403 partial_unauthorized', async () => {
      const seed = await seedPendingCitation({ userRole: 'viewer' });
      const res = await request(app)
        .post('/admin/knowledge/review-extractions/bulk/approve')
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seed.citationId] });
      expect(res.status).toBe(403);
    });

    test('admin succeeds across any ids', async () => {
      const seedA = await seedPendingCitation({ userRole: 'manager' });
      const seedB = await seedPendingCitation({ userRole: 'manager' });
      const res = await request(app)
        .post('/admin/knowledge/review-extractions/bulk/approve')
        .set('x-user-id', String(adminUserId))
        .set('x-user-role', 'admin')
        .send({ ids: [seedA.citationId, seedB.citationId] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /admin/knowledge/review-extractions/bulk/reject', () => {
    test('in-collection manager succeeds; mixed batch 403', async () => {
      const seedA = await seedPendingCitation({ userRole: 'manager' });
      const seedB = await seedPendingCitation({ userRole: 'manager' });
      const okRes = await request(app)
        .post('/admin/knowledge/review-extractions/bulk/reject')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seedA.citationId] });
      expect(okRes.status).toBe(200);
      expect(okRes.body.success).toBe(true);

      const mixedRes = await request(app)
        .post('/admin/knowledge/review-extractions/bulk/reject')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seedA.citationId, seedB.citationId] });
      expect(mixedRes.status).toBe(403);
    });
  });

  describe('POST /admin/knowledge/review-extractions/bulk/delete', () => {
    test('in-collection manager succeeds; out-of-collection batch 403', async () => {
      const seedA = await seedPendingCitation({ userRole: 'manager' });
      const seedB = await seedPendingCitation({ userRole: 'manager' });
      const okRes = await request(app)
        .post('/admin/knowledge/review-extractions/bulk/delete')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seedA.citationId] });
      expect(okRes.status).toBe(200);

      const denyRes = await request(app)
        .post('/admin/knowledge/review-extractions/bulk/delete')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .send({ ids: [seedB.citationId] });
      expect(denyRes.status).toBe(403);
    });
  });
});
