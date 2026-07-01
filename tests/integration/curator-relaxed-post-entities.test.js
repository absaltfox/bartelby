'use strict';

// Integration tests for Task 4.2 — relaxed entity correction and authoring
// POST endpoints.
//
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Relaxed POST endpoints (explicit enumeration)", entity correction
// endpoints swap requireAdmin for requireCurate('entity', 'id') and the
// authoring/merge endpoints use the custom predicates documented inline
// in routes/admin-entities.js.
//
// We cover the four-case matrix on the canonical edit/delete path and
// confirm the specials (new, merge) gate on transcript document and
// both endpoints respectively. The bulk pattern is exercised in Task
// 4.1 and the same middleware shape is reused.

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

const entitiesRouter = require('../../routes/admin-entities');

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
  app.use('/admin/knowledge/entities', entitiesRouter);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function seedEntityInCollection({ userRole = 'manager' } = {}) {
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
    content: 'fixture transcript with some text in it',
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
    approval_status: 'approved'
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

describe('Relaxed POST: entity correction endpoints', () => {
  let app;

  beforeAll(async () => {
    await initApp();
    app = buildAppWithFakeAuth();
  });

  describe('POST /admin/knowledge/entities/:id/edit', () => {
    test('admin succeeds', async () => {
      const seed = await seedEntityInCollection();
      const res = await request(app)
        .post(`/admin/knowledge/entities/${seed.entityId}/edit`)
        .set('x-user-id', '1')
        .set('x-user-role', 'admin')
        .type('form')
        .send({
          entity_type: 'person',
          canonical_name: 'Updated Name',
          description: ''
        });
      expect([200, 302]).toContain(res.status);
    });

    test('in-collection manager succeeds', async () => {
      const seed = await seedEntityInCollection({ userRole: 'manager' });
      const res = await request(app)
        .post(`/admin/knowledge/entities/${seed.entityId}/edit`)
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({
          entity_type: 'person',
          canonical_name: 'Renamed by Manager',
          description: ''
        });
      expect([200, 302]).toContain(res.status);
    });

    test('out-of-collection manager gets 404', async () => {
      const seedA = await seedEntityInCollection({ userRole: 'manager' });
      const seedB = await seedEntityInCollection({ userRole: 'manager' });
      const res = await request(app)
        .post(`/admin/knowledge/entities/${seedB.entityId}/edit`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ entity_type: 'person', canonical_name: 'Cross-Coll Attempt' });
      expect(res.status).toBe(404);
    });

    test('viewer role gets 404', async () => {
      const seed = await seedEntityInCollection({ userRole: 'viewer' });
      const res = await request(app)
        .post(`/admin/knowledge/entities/${seed.entityId}/edit`)
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({ entity_type: 'person', canonical_name: 'Viewer Attempt' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /admin/knowledge/entities/:id/delete', () => {
    test('out-of-collection manager gets 404; in-collection manager 302', async () => {
      const seedA = await seedEntityInCollection({ userRole: 'manager' });
      const seedB = await seedEntityInCollection({ userRole: 'manager' });

      const okRes = await request(app)
        .post(`/admin/knowledge/entities/${seedA.entityId}/delete`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({});
      expect([200, 302]).toContain(okRes.status);

      const denyRes = await request(app)
        .post(`/admin/knowledge/entities/${seedB.entityId}/delete`)
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({});
      expect(denyRes.status).toBe(404);
    });
  });

  describe('POST /admin/knowledge/entities/new (custom transcript predicate)', () => {
    test('in-collection manager succeeds via transcript document', async () => {
      const seed = await seedEntityInCollection({ userRole: 'manager' });
      // The verbatim text must exist in transcript content to pass evidence
      // resolution. seed.transcriptsAsync content = "fixture transcript with some text in it"
      const res = await request(app)
        .post('/admin/knowledge/entities/new')
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({
          entity_type: 'person',
          canonical_name: 'Newly Created',
          transcriptId: String(seed.transcriptId),
          verbatim: 'fixture transcript',
          passageStart: '0'
        });
      expect([200, 302]).toContain(res.status);
    });

    test('out-of-collection manager gets 404', async () => {
      const seedA = await seedEntityInCollection({ userRole: 'manager' });
      const seedB = await seedEntityInCollection({ userRole: 'manager' });
      const res = await request(app)
        .post('/admin/knowledge/entities/new')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({
          entity_type: 'person',
          canonical_name: 'Cross-Coll',
          transcriptId: String(seedB.transcriptId),
          verbatim: 'fixture transcript'
        });
      expect(res.status).toBe(404);
    });

    test('viewer role gets 404', async () => {
      const seed = await seedEntityInCollection({ userRole: 'viewer' });
      const res = await request(app)
        .post('/admin/knowledge/entities/new')
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({
          entity_type: 'person',
          canonical_name: 'Viewer Attempt',
          transcriptId: String(seed.transcriptId),
          verbatim: 'fixture transcript'
        });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /admin/knowledge/entities/merge (requires both endpoints)', () => {
    test('manager curating both source and target in same collection succeeds reaching handler', async () => {
      const seed = await seedEntityInCollection({ userRole: 'manager' });
      // Add a second entity within the same collection
      const e2 = await entitiesAsync.create({ canonical_name: 'Second', entity_type: 'person' });
      await citationsAsync.create({
        entity_id: e2,
        transcript_id: seed.transcriptId,
        document_id: seed.documentId,
        passage_text: 'fixture passage',
        extraction_method: 'manual',
        approval_status: 'approved'
      });
      const res = await request(app)
        .post('/admin/knowledge/entities/merge')
        .set('x-user-id', String(seed.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({
          source_entity_id: String(e2),
          target_entity_id: String(seed.entityId)
        });
      // Handler always redirects; success vs error is fine — we only verify the
      // predicate gate let us through (not a 404).
      expect(res.status).not.toBe(404);
      expect([200, 302]).toContain(res.status);
    });

    test('manager with rights on only one entity gets 404', async () => {
      const seedA = await seedEntityInCollection({ userRole: 'manager' });
      const seedB = await seedEntityInCollection({ userRole: 'manager' });
      const res = await request(app)
        .post('/admin/knowledge/entities/merge')
        .set('x-user-id', String(seedA.user.id))
        .set('x-user-role', 'user')
        .type('form')
        .send({
          source_entity_id: String(seedA.entityId),
          target_entity_id: String(seedB.entityId)
        });
      expect(res.status).toBe(404);
    });
  });
});
