'use strict';

// Integration tests for Task 4.3 — relaxed relationship authoring POST.
//
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Relaxed POST endpoints", POST /new on relationships gates on the
// transcript's document → collections chain. The custom middleware
// requireCurateNewRelationshipForTranscript implements that check.
//
// The handler itself enforces additional preconditions (relationship
// type membership in the active vocabulary, source/target type matches,
// verbatim presence in the transcript). For the gate test we only need
// to assert that the gate either passes the request through or returns
// 404 — the handler's own redirect-on-error is fine as a "passed the
// gate" signal.

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

const relationshipsRouter = require('../../routes/admin-relationships');

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
  app.use('/admin/knowledge/relationships', relationshipsRouter);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function seedTwoEntitiesInCollection({ userRole = 'manager' } = {}) {
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
    content: 'fixture relationship transcript text',
    transcriber: 'fixture',
    notes: null
  });
  const sourceEntityId = await entitiesAsync.create({
    canonical_name: `S-${unique}`,
    entity_type: 'person'
  });
  await citationsAsync.create({
    entity_id: sourceEntityId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_text: 'fixture passage',
    extraction_method: 'manual',
    approval_status: 'approved'
  });
  const targetEntityId = await entitiesAsync.create({
    canonical_name: `T-${unique}`,
    entity_type: 'person'
  });
  await citationsAsync.create({
    entity_id: targetEntityId,
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
    sourceEntityId,
    targetEntityId
  };
}

describe('Relaxed POST /admin/knowledge/relationships/new', () => {
  let app;

  beforeAll(async () => {
    await initApp();
    app = buildAppWithFakeAuth();
  });

  test('admin reaches handler (gate passes; downstream may redirect)', async () => {
    const seed = await seedTwoEntitiesInCollection();
    const res = await request(app)
      .post('/admin/knowledge/relationships/new')
      .set('x-user-id', '1')
      .set('x-user-role', 'admin')
      .type('form')
      .send({
        source_entity_id: String(seed.sourceEntityId),
        target_entity_id: String(seed.targetEntityId),
        relationship_type: 'mentioned_in',
        transcriptId: String(seed.transcriptId),
        verbatim: 'fixture relationship transcript'
      });
    expect(res.status).not.toBe(404);
  });

  test('in-collection manager passes the gate', async () => {
    const seed = await seedTwoEntitiesInCollection({ userRole: 'manager' });
    const res = await request(app)
      .post('/admin/knowledge/relationships/new')
      .set('x-user-id', String(seed.user.id))
      .set('x-user-role', 'user')
      .type('form')
      .send({
        source_entity_id: String(seed.sourceEntityId),
        target_entity_id: String(seed.targetEntityId),
        relationship_type: 'mentioned_in',
        transcriptId: String(seed.transcriptId),
        verbatim: 'fixture relationship transcript'
      });
    expect(res.status).not.toBe(404);
  });

  test('out-of-collection manager gets 404', async () => {
    const seedA = await seedTwoEntitiesInCollection({ userRole: 'manager' });
    const seedB = await seedTwoEntitiesInCollection({ userRole: 'manager' });
    const res = await request(app)
      .post('/admin/knowledge/relationships/new')
      .set('x-user-id', String(seedA.user.id))
      .set('x-user-role', 'user')
      .type('form')
      .send({
        source_entity_id: String(seedB.sourceEntityId),
        target_entity_id: String(seedB.targetEntityId),
        relationship_type: 'mentioned_in',
        transcriptId: String(seedB.transcriptId),
        verbatim: 'fixture relationship transcript'
      });
    expect(res.status).toBe(404);
  });

  test('viewer role gets 404', async () => {
    const seed = await seedTwoEntitiesInCollection({ userRole: 'viewer' });
    const res = await request(app)
      .post('/admin/knowledge/relationships/new')
      .set('x-user-id', String(seed.user.id))
      .set('x-user-role', 'user')
      .type('form')
      .send({
        source_entity_id: String(seed.sourceEntityId),
        target_entity_id: String(seed.targetEntityId),
        relationship_type: 'mentioned_in',
        transcriptId: String(seed.transcriptId),
        verbatim: 'fixture relationship transcript'
      });
    expect(res.status).toBe(404);
  });
});
