'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

const {
  authoritiesAsync,
  entitiesAsync,
  citationsAsync,
  documentsAsync,
  transcriptsAsync,
  collectionsAsync,
  documentCollectionsAsync,
  usersAsync
} = require('../../database/db');
const { initApp } = require('../../server');

async function createCollection() {
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
  return { userId, collectionId };
}

async function attachEntityToCollection({ collectionId, authorityId }) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
    content: 'fixture',
    transcriber: 'fixture',
    notes: null
  });
  const entityId = await entitiesAsync.create({
    canonical_name: `E-${unique}`,
    entity_type: 'person',
    authority_id: authorityId
  });
  await citationsAsync.create({
    entity_id: entityId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_text: 'fixture',
    extraction_method: 'manual',
    approval_status: 'approved'
  });
  return { documentId, transcriptId, entityId };
}

describe('authoritiesAsync.listTouchedByCollection', () => {
  beforeAll(async () => { await initApp(); });

  test('returns authorities with member entities in the given collection, with in/total member counts', async () => {
    const c1 = await createCollection();
    const c2 = await createCollection();

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const authA = await authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: `Auth-A-${unique}`,
      description: null,
      properties: {},
      external_source: null,
      external_key: null
    });
    const authB = await authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: `Auth-B-${unique}`,
      description: null,
      properties: {},
      external_source: null,
      external_key: null
    });

    // Authority A: one member in c1, one member in c2.
    await attachEntityToCollection({ collectionId: c1.collectionId, authorityId: authA });
    await attachEntityToCollection({ collectionId: c2.collectionId, authorityId: authA });

    // Authority B: only one member, in c2.
    await attachEntityToCollection({ collectionId: c2.collectionId, authorityId: authB });

    const rowsC1 = await authoritiesAsync.listTouchedByCollection(c1.collectionId);
    const rowsC1ById = new Map(rowsC1.map((r) => [r.id, r]));
    expect(rowsC1ById.has(authA)).toBe(true);
    expect(rowsC1ById.has(authB)).toBe(false);
    const a1 = rowsC1ById.get(authA);
    expect(Number(a1.in_collection_members)).toBe(1);
    expect(Number(a1.total_members)).toBe(2);

    const rowsC2 = await authoritiesAsync.listTouchedByCollection(c2.collectionId);
    const rowsC2ById = new Map(rowsC2.map((r) => [r.id, r]));
    expect(rowsC2ById.has(authA)).toBe(true);
    expect(rowsC2ById.has(authB)).toBe(true);
    const a2 = rowsC2ById.get(authA);
    expect(Number(a2.in_collection_members)).toBe(1);
    expect(Number(a2.total_members)).toBe(2);
    const b2 = rowsC2ById.get(authB);
    expect(Number(b2.in_collection_members)).toBe(1);
    expect(Number(b2.total_members)).toBe(1);
  });

  test('counts each entity once even if it has multiple citations', async () => {
    const c = await createCollection();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const auth = await authoritiesAsync.create({
      authority_type: 'person',
      canonical_name: `Auth-${unique}`,
      description: null,
      properties: {},
      external_source: null,
      external_key: null
    });
    const seed = await attachEntityToCollection({ collectionId: c.collectionId, authorityId: auth });
    // Add a second citation for the same entity (same doc, different passage).
    await citationsAsync.create({
      entity_id: seed.entityId,
      transcript_id: seed.transcriptId,
      document_id: seed.documentId,
      passage_text: 'second passage',
      passage_start: 100,
      passage_end: 110,
      extraction_method: 'manual',
      approval_status: 'approved'
    });

    const rows = await authoritiesAsync.listTouchedByCollection(c.collectionId);
    const row = rows.find((r) => r.id === auth);
    expect(row).toBeTruthy();
    expect(Number(row.in_collection_members)).toBe(1);
    expect(Number(row.total_members)).toBe(1);
  });
});
