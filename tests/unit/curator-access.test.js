'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';

const {
  curatorAccessAsync,
  usersAsync,
  collectionsAsync,
  documentsAsync,
  documentCollectionsAsync,
  userCollectionAccessAsync,
  transcriptsAsync,
  entitiesAsync,
  citationsAsync
} = require('../../database/db');
const { initApp } = require('../../server');

// Seed an entity-in-collection chain that mirrors the real-world layout:
//
//   user — user_collection_access[role] — collection
//                                              |
//   document — document_collections — collection
//      |
//   transcript — citation[entity_id] — entity
//
// Entities don't carry a document_id column (see migrations.js v44 — the
// entity → document edge runs through citations), so the curator-access
// predicate resolves containment via citations.document_id. The fixture
// therefore must create the transcript + citation, not just the entity.
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
  await citationsAsync.create({
    entity_id: entityId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_text: 'fixture passage',
    extraction_method: 'manual',
    approval_status: 'approved'
  });
  await userCollectionAccessAsync.grant(userId, collectionId, userRole);
  return { user: { id: userId, role: 'user' }, collectionId, entityId };
}

describe('curatorAccessAsync.userCanCurateEntity', () => {
  beforeAll(async () => { await initApp(); });

  test('admin is always allowed', async () => {
    const result = await curatorAccessAsync.userCanCurateEntity(
      { id: 1, role: 'admin' },
      9999
    );
    expect(result).toEqual({ allowed: true, collectionIds: null });
  });

  test("manager on the entity's collection is allowed", async () => {
    const { user, entityId, collectionId } = await seedEntityInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateEntity(user, entityId);
    expect(result.allowed).toBe(true);
    expect(result.collectionIds).toContain(collectionId);
  });

  test("viewer on the entity's collection is denied", async () => {
    const { user, entityId } = await seedEntityInCollection({ userRole: 'viewer' });
    const result = await curatorAccessAsync.userCanCurateEntity(user, entityId);
    expect(result.allowed).toBe(false);
  });

  test('manager on a different collection is denied', async () => {
    const { user } = await seedEntityInCollection({ userRole: 'manager' });
    const other = await seedEntityInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateEntity(user, other.entityId);
    expect(result.allowed).toBe(false);
  });

  test('non-existent entity returns same shape as forbidden', async () => {
    const { user } = await seedEntityInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateEntity(user, 9999999);
    expect(result.allowed).toBe(false);
  });
});
