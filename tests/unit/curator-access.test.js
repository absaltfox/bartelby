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
  citationsAsync,
  relationshipsAsync,
  dateExpressionsAsync
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

// Seed a relationship by reusing the entity+citation chain for the source
// entity, then attaching a second entity to the same document via a
// secondary citation so both endpoints share collection membership. The
// relationship row only carries source_entity_id / target_entity_id; we
// resolve collection scope through source per the predicate convention.
async function seedRelationshipInCollection({ userRole = 'manager' } = {}) {
  const seed = await seedEntityInCollection({ userRole });
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const targetEntityId = await entitiesAsync.create({
    canonical_name: `T-${unique}`,
    entity_type: 'person'
  });
  await citationsAsync.create({
    entity_id: targetEntityId,
    transcript_id: seed.transcriptId,
    document_id: seed.documentId,
    passage_text: 'target fixture passage',
    extraction_method: 'manual',
    approval_status: 'approved'
  });
  const relationshipId = await relationshipsAsync.create({
    source_entity_id: seed.entityId,
    target_entity_id: targetEntityId,
    relationship_type: 'knows',
    label: 'fixture relationship',
    properties: {},
    confidence: 1
  });
  return { ...seed, targetEntityId, relationshipId };
}

// Seed a date expression hanging off the entity from seedEntityInCollection.
async function seedDateExpressionInCollection({ userRole = 'manager' } = {}) {
  const seed = await seedEntityInCollection({ userRole });
  const dateExpressionId = await dateExpressionsAsync.create({
    entity_id: seed.entityId,
    label: 'fixture date',
    earliest: '1900-01-01',
    latest: '1900-12-31',
    precision: 'year',
    qualifier: null,
    calendar: 'gregorian'
  });
  return { ...seed, dateExpressionId };
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

describe('curatorAccessAsync.userCanCurateCitation', () => {
  beforeAll(async () => { await initApp(); });

  test('admin is always allowed', async () => {
    const result = await curatorAccessAsync.userCanCurateCitation(
      { id: 1, role: 'admin' },
      9999
    );
    expect(result).toEqual({ allowed: true, collectionIds: null });
  });

  test("manager on the citation's collection is allowed", async () => {
    const { user, citationId, collectionId } = await seedEntityInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateCitation(user, citationId);
    expect(result.allowed).toBe(true);
    expect(result.collectionIds).toContain(collectionId);
  });

  test("viewer on the citation's collection is denied", async () => {
    const { user, citationId } = await seedEntityInCollection({ userRole: 'viewer' });
    const result = await curatorAccessAsync.userCanCurateCitation(user, citationId);
    expect(result.allowed).toBe(false);
  });

  test('manager on a different collection is denied', async () => {
    const { user } = await seedEntityInCollection({ userRole: 'manager' });
    const other = await seedEntityInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateCitation(user, other.citationId);
    expect(result.allowed).toBe(false);
  });

  test('non-existent citation returns same shape as forbidden', async () => {
    const { user } = await seedEntityInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateCitation(user, 9999999);
    expect(result.allowed).toBe(false);
  });
});

describe('curatorAccessAsync.userCanCurateRelationship', () => {
  beforeAll(async () => { await initApp(); });

  test('admin is always allowed', async () => {
    const result = await curatorAccessAsync.userCanCurateRelationship(
      { id: 1, role: 'admin' },
      9999
    );
    expect(result).toEqual({ allowed: true, collectionIds: null });
  });

  test("manager on the relationship's collection is allowed", async () => {
    const { user, relationshipId, collectionId } = await seedRelationshipInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateRelationship(user, relationshipId);
    expect(result.allowed).toBe(true);
    expect(result.collectionIds).toContain(collectionId);
  });

  test("viewer on the relationship's collection is denied", async () => {
    const { user, relationshipId } = await seedRelationshipInCollection({ userRole: 'viewer' });
    const result = await curatorAccessAsync.userCanCurateRelationship(user, relationshipId);
    expect(result.allowed).toBe(false);
  });

  test('manager on a different collection is denied', async () => {
    const { user } = await seedRelationshipInCollection({ userRole: 'manager' });
    const other = await seedRelationshipInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateRelationship(user, other.relationshipId);
    expect(result.allowed).toBe(false);
  });

  test('non-existent relationship returns same shape as forbidden', async () => {
    const { user } = await seedRelationshipInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateRelationship(user, 9999999);
    expect(result.allowed).toBe(false);
  });
});

describe('curatorAccessAsync.userCanCurateDateExpression', () => {
  beforeAll(async () => { await initApp(); });

  test('admin is always allowed', async () => {
    const result = await curatorAccessAsync.userCanCurateDateExpression(
      { id: 1, role: 'admin' },
      9999
    );
    expect(result).toEqual({ allowed: true, collectionIds: null });
  });

  test("manager on the date expression's collection is allowed", async () => {
    const { user, dateExpressionId, collectionId } = await seedDateExpressionInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateDateExpression(user, dateExpressionId);
    expect(result.allowed).toBe(true);
    expect(result.collectionIds).toContain(collectionId);
  });

  test("viewer on the date expression's collection is denied", async () => {
    const { user, dateExpressionId } = await seedDateExpressionInCollection({ userRole: 'viewer' });
    const result = await curatorAccessAsync.userCanCurateDateExpression(user, dateExpressionId);
    expect(result.allowed).toBe(false);
  });

  test('manager on a different collection is denied', async () => {
    const { user } = await seedDateExpressionInCollection({ userRole: 'manager' });
    const other = await seedDateExpressionInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateDateExpression(user, other.dateExpressionId);
    expect(result.allowed).toBe(false);
  });

  test('non-existent date expression returns same shape as forbidden', async () => {
    const { user } = await seedDateExpressionInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateDateExpression(user, 9999999);
    expect(result.allowed).toBe(false);
  });
});
