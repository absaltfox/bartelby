'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';

const request = require('supertest');
const express = require('express');
const { initApp } = require('../../server');
const {
  requireCurate,
  requireCurateAll
} = require('../../middleware/curator-permissions');
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

// Reuses the same entity-in-collection chain shape from the unit tests
// (transcript + citation linking an entity to a document_collection), so the
// curator-access predicate has a real row set to walk for the manager case.
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

// Add a second citation in the same collection so a single manager can act
// on multiple citation ids in one bulk request.
async function addCitationInCollection({ documentId, transcriptId }) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const entityId = await entitiesAsync.create({
    canonical_name: `E-${unique}`,
    entity_type: 'person'
  });
  const citationId = await citationsAsync.create({
    entity_id: entityId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_text: 'fixture passage 2',
    extraction_method: 'manual',
    approval_status: 'approved'
  });
  return { entityId, citationId };
}

// Build an Express app whose auth shim selects req.user by an `x-user-id`
// header. The header carries the seeded user id and role we want to inject
// (or `admin` for the admin short-circuit case). This avoids standing up
// passport/session machinery just to flip identities between assertions.
function buildAppWithFakeAuth(mountFn) {
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
  mountFn(app);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe('requireCurate middleware', () => {
  let app;

  beforeAll(async () => {
    await initApp();
    app = express();
    app.use(express.json());
    // Inject auth: pretend the user is an admin so the predicate short-circuits.
    app.use((req, res, next) => {
      req.user = { id: 1, role: 'admin' };
      req.isAuthenticated = () => true;
      next();
    });
    app.post('/test/:id', requireCurate('entity', 'id'), (req, res) => res.json({ ok: true }));
    // Error handler so asyncHandler-bubbled errors yield a real status code.
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
    });
  });

  test('admin reaches the handler', async () => {
    const res = await request(app).post('/test/1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('non-numeric route param returns 404 without running the predicate', async () => {
    const res = await request(app).post('/test/5abc');
    expect(res.status).toBe(404);
  });

  test('leading-zero route param is rejected', async () => {
    // '007' -> parseInt gives 7 silently, but audit-log evidence should
    // match the route param string exactly. Reject cleanly.
    const res = await request(app).post('/test/007');
    expect(res.status).toBe(404);
  });

  test('negative route param is rejected', async () => {
    const res = await request(app).post('/test/-1');
    expect(res.status).toBe(404);
  });
});

describe('requireCurateAll middleware', () => {
  let app;

  beforeAll(async () => {
    await initApp();
    app = buildAppWithFakeAuth((a) => {
      a.post(
        '/bulk',
        requireCurateAll('citation', 'citationIds'),
        (req, res) => res.json({ ok: true })
      );
    });
  });

  test('manager with all permitted citations reaches the handler', async () => {
    const seed = await seedEntityInCollection({ userRole: 'manager' });
    const extra = await addCitationInCollection({
      documentId: seed.documentId,
      transcriptId: seed.transcriptId
    });
    const res = await request(app)
      .post('/bulk')
      .set('x-user-id', String(seed.user.id))
      .set('x-user-role', 'user')
      .send({ citationIds: [seed.citationId, extra.citationId] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('mixed batch with one unpermitted citation returns 403 with unauthorizedIds', async () => {
    const seedA = await seedEntityInCollection({ userRole: 'manager' });
    // Different user, different collection — seedA's user has no access here.
    const seedB = await seedEntityInCollection({ userRole: 'manager' });
    const res = await request(app)
      .post('/bulk')
      .set('x-user-id', String(seedA.user.id))
      .set('x-user-role', 'user')
      .send({ citationIds: [seedA.citationId, seedB.citationId] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('partial_unauthorized');
    expect(res.body.unauthorizedIds).toEqual([seedB.citationId]);
  });

  test('empty body field returns 400', async () => {
    const seed = await seedEntityInCollection({ userRole: 'manager' });
    const res = await request(app)
      .post('/bulk')
      .set('x-user-id', String(seed.user.id))
      .set('x-user-role', 'user')
      .send({ citationIds: [] });
    expect(res.status).toBe(400);
  });

  test('over-BULK_CAP payload is rejected with too_many_ids before any predicate runs', async () => {
    // 201 numeric ids exceeds BULK_CAP=200. Middleware must reject with 400
    // BEFORE issuing predicate work.
    const seed = await seedEntityInCollection({ userRole: 'manager' });
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await request(app)
      .post('/bulk')
      .set('x-user-id', String(seed.user.id))
      .set('x-user-role', 'user')
      .send({ citationIds: ids });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('too_many_ids');
    expect(res.body.max).toBe(200);
  });
});
