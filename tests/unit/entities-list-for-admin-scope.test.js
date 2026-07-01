'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

const {
  entitiesAsync,
  citationsAsync,
  authoritiesAsync,
  documentsAsync,
  transcriptsAsync,
  collectionsAsync,
  documentCollectionsAsync,
  usersAsync
} = require('../../database/db');
const { initApp } = require('../../server');

// Build the standard document -> transcript -> citation -> entity chain
// so we can scope the entity to a collection via citations.document_id.
async function seedEntityInCollection({ entityType = 'person', linkAuthority = false } = {}) {
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
    content: 'fixture',
    transcriber: 'fixture',
    notes: null
  });
  let authorityId = null;
  if (linkAuthority) {
    authorityId = await authoritiesAsync.create({
      authority_type: entityType,
      canonical_name: `A-${unique}`,
      description: null,
      properties: {},
      external_source: null,
      external_key: null
    });
  }
  const entityId = await entitiesAsync.create({
    canonical_name: `E-${unique}`,
    entity_type: entityType,
    authority_id: authorityId
  });
  await citationsAsync.create({
    entity_id: entityId,
    transcript_id: transcriptId,
    document_id: documentId,
    passage_text: 'fixture passage',
    extraction_method: 'manual',
    approval_status: 'approved'
  });
  return { userId, collectionId, documentId, entityId, authorityId, entityType };
}

describe('entitiesAsync.listForAdmin — collectionId/type/unresolved opts', () => {
  beforeAll(async () => { await initApp(); });

  test('without opts, returns a list of entities', async () => {
    await seedEntityInCollection({ entityType: 'person' });
    const rows = await entitiesAsync.listForAdmin();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('collectionId filters to entities cited in that collection', async () => {
    const a = await seedEntityInCollection({ entityType: 'person' });
    const b = await seedEntityInCollection({ entityType: 'person' });
    const rowsA = await entitiesAsync.listForAdmin({ collectionId: a.collectionId, limit: 5000 });
    const idsA = rowsA.map((r) => r.id);
    expect(idsA).toContain(a.entityId);
    expect(idsA).not.toContain(b.entityId);
  });

  test('type filters by entity_type', async () => {
    const person = await seedEntityInCollection({ entityType: 'person' });
    const place = await seedEntityInCollection({ entityType: 'place' });
    const rows = await entitiesAsync.listForAdmin({ type: 'place', limit: 5000 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(place.entityId);
    expect(ids).not.toContain(person.entityId);
  });

  test('unresolved=true filters to authority_id IS NULL', async () => {
    const unresolved = await seedEntityInCollection({ entityType: 'person', linkAuthority: false });
    const resolved = await seedEntityInCollection({ entityType: 'person', linkAuthority: true });
    const rows = await entitiesAsync.listForAdmin({ unresolved: true, limit: 5000 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(unresolved.entityId);
    expect(ids).not.toContain(resolved.entityId);
  });

  test('all opts compose: collectionId + type + unresolved together', async () => {
    const target = await seedEntityInCollection({ entityType: 'place', linkAuthority: false });
    const wrongType = await seedEntityInCollection({ entityType: 'person', linkAuthority: false });
    const wrongAuth = await seedEntityInCollection({ entityType: 'place', linkAuthority: true });
    // Add a fourth entity in a different collection — should be excluded.
    const wrongColl = await seedEntityInCollection({ entityType: 'place', linkAuthority: false });

    const rows = await entitiesAsync.listForAdmin({
      collectionId: target.collectionId,
      type: 'place',
      unresolved: true,
      limit: 5000
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(target.entityId);
    expect(ids).not.toContain(wrongType.entityId);
    expect(ids).not.toContain(wrongAuth.entityId);
    expect(ids).not.toContain(wrongColl.entityId);
  });
});
