'use strict';

/**
 * Covers the batched entity-visibility filter that replaced the serial
 * `canAccessEntity` loop on `/graph/documents/:id/entities`.
 *
 * The loop is retained as `graphAccess.canAccessEntity` (it is still the
 * right shape for single-entity checks), so the strongest available
 * assertion is direct equivalence: for every viewer and every
 * `collectionId` scoping, the batched filter must return exactly the set the
 * loop would have built. Per docs/development-principles.md (Respect
 * Permissions by Default), the access boundary has to be provably unchanged.
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, findings P6/P18).
 */

process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';

const bcrypt = require('bcryptjs');
const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function login(agent, username) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username, password: 'password123!', _csrf: csrf });
  expect(res.status).toBe(302);
}

async function bootApp() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  const server = require('../../server');
  await server.initApp();
  return { app: server.app, db: require('../../database/db') };
}

describe('document graph entity access filtering', () => {
  let app;
  let db;
  let publicCollectionId;
  let privateCollectionId;
  let publicDocId;
  let privateDocId;
  let publicOnlyEntityId;
  let privateOnlyEntityId;
  let sharedEntityId;
  let readerUserId;
  let curatorUserId;

  beforeAll(async () => {
    ({ app, db } = await bootApp());

    publicCollectionId = await db.collectionsAsync.create({
      name: 'Doc Entities Public Collection',
      description: null,
      is_public: true,
      is_world_public: true,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });
    privateCollectionId = await db.collectionsAsync.create({
      name: 'Doc Entities Private Collection',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false,
      createdBy: null
    });

    readerUserId = await db.usersAsync.create({
      username: 'doc_entities_reader',
      email: 'doc-entities-reader@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    curatorUserId = await db.usersAsync.create({
      username: 'doc_entities_curator',
      email: 'doc-entities-curator@example.com',
      passwordHash: bcrypt.hashSync('password123!', 10),
      role: 'user',
      status: 'active',
      accessAll: false,
      canUseSystemApiKeys: false
    });
    await db.userCollectionAccessAsync.grant(curatorUserId, privateCollectionId, 'viewer');

    const makeDocument = async (title, collectionId) => {
      const documentId = await db.documentsAsync.create({
        title,
        date_created: null,
        description: null,
        image_path: null,
        metadata: {}
      });
      await db.documentCollectionsAsync.setForDocument(documentId, [collectionId]);
      const transcriptId = await db.transcriptsAsync.create({
        document_id: documentId,
        content: `${title} transcript body`,
        transcriber: 'manual',
        version: 1,
        notes: null,
        is_best: true,
        created_by_user_id: null
      });
      return { documentId, transcriptId };
    };

    const publicDoc = await makeDocument('Doc Entities Public Document', publicCollectionId);
    const privateDoc = await makeDocument('Doc Entities Private Document', privateCollectionId);
    publicDocId = publicDoc.documentId;
    privateDocId = privateDoc.documentId;

    const cite = async (entityId, doc) => {
      await db.citationsAsync.create({
        entity_id: entityId,
        relationship_id: null,
        transcript_id: doc.transcriptId,
        document_id: doc.documentId,
        passage_start: 0,
        passage_end: 12,
        passage_text: 'Doc Entities passage',
        extraction_method: 'manual',
        extraction_model: null,
        confidence: 1.0,
        approval_status: 'approved',
        approval_method: 'manual'
      });
    };

    publicOnlyEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Doc Entities Public Only',
      description: null,
      properties: {}
    });
    await cite(publicOnlyEntityId, publicDoc);

    privateOnlyEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Doc Entities Private Only',
      description: null,
      properties: {}
    });
    await cite(privateOnlyEntityId, privateDoc);

    sharedEntityId = await db.entitiesAsync.create({
      entity_type: 'person',
      canonical_name: 'Doc Entities Shared',
      description: null,
      properties: {}
    });
    await cite(sharedEntityId, publicDoc);
    await cite(sharedEntityId, privateDoc);
  }, 60_000);

  it('returns exactly what the per-entity loop returns, for every viewer and scoping', async () => {
    const graphAccess = db.graphAccessAsync;
    const candidateIds = [publicOnlyEntityId, privateOnlyEntityId, sharedEntityId];
    const viewers = [
      { label: 'anonymous', userId: null, isAdmin: false, accessAll: false },
      { label: 'reader without private access', userId: readerUserId, isAdmin: false, accessAll: false },
      { label: 'curator with private access', userId: curatorUserId, isAdmin: false, accessAll: false },
      { label: 'admin', userId: null, isAdmin: true, accessAll: true }
    ];
    const scopings = [null, publicCollectionId, privateCollectionId];

    for (const viewer of viewers) {
      for (const collectionId of scopings) {
        const loopResult = [];
        for (const id of candidateIds) {
          const allowed = await graphAccess.canAccessEntity(
            id, viewer.userId, viewer.isAdmin, viewer.accessAll, collectionId
          );
          if (allowed) loopResult.push(id);
        }
        const batched = await graphAccess.filterAccessibleEntityIds(
          candidateIds, viewer.userId, viewer.isAdmin, viewer.accessAll, collectionId
        );

        expect({
          viewer: viewer.label,
          collectionId,
          ids: Array.from(batched).sort((a, b) => a - b)
        }).toEqual({
          viewer: viewer.label,
          collectionId,
          ids: loopResult.sort((a, b) => a - b)
        });
      }
    }
  });

  it('still hides private-collection entities from an unauthorized reader', async () => {
    const agent = request.agent(app);
    await login(agent, 'doc_entities_reader');

    const res = await agent.get(`/graph/documents/${publicDocId}/entities`);
    expect(res.status).toBe(200);

    const ids = res.body.entities.map((entity) => entity.id);
    expect(ids).toContain(publicOnlyEntityId);
    expect(ids).toContain(sharedEntityId);
    expect(ids).not.toContain(privateOnlyEntityId);

    const privateRes = await agent.get(`/graph/documents/${privateDocId}/entities`);
    expect(privateRes.status).toBe(404);
  });

  it('preserves collectionId scoping on the batched query', async () => {
    const agent = request.agent(app);
    await login(agent, 'doc_entities_curator');

    // Unscoped: both entities on the public document are visible.
    const unscoped = await agent.get(`/graph/documents/${publicDocId}/entities`);
    expect(unscoped.status).toBe(200);
    expect(unscoped.body.entities.map((e) => e.id).sort((a, b) => a - b))
      .toEqual([publicOnlyEntityId, sharedEntityId].sort((a, b) => a - b));

    // Scoped to the private collection: only the entity that also has a
    // citation inside that collection survives, even though the request is
    // for a document in the public collection.
    const scoped = await agent
      .get(`/graph/documents/${publicDocId}/entities`)
      .query({ collectionId: privateCollectionId });
    expect(scoped.status).toBe(200);
    expect(scoped.body.entities.map((e) => e.id)).toEqual([sharedEntityId]);
  });
});
