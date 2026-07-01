'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

const {
  citationsAsync,
  entitiesAsync,
  documentsAsync,
  transcriptsAsync,
  collectionsAsync,
  documentCollectionsAsync,
  usersAsync,
  runAsync
} = require('../../database/db');
const { initApp } = require('../../server');

// Seed a pending citation attached to a freshly-created entity, document,
// transcript, and collection. The chain mirrors the layout used in
// curator-access.test.js — entities don't carry document_id (see
// migrations.js v44 — entity → document edge runs through citations), so
// every fixture creates the citation that pins entity-in-collection
// membership.
async function seedPendingCitationInCollection() {
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
    passage_start: 0,
    passage_end: 1,
    extraction_method: 'llm_auto',
    approval_status: 'pending'
  });
  return { userId, collectionId, documentId, transcriptId, entityId, citationId };
}

describe('citationsAsync.listPending — collectionId scope', () => {
  beforeAll(async () => { await initApp(); });

  test('without collectionId opt, returns pending citations from any collection', async () => {
    const seedA = await seedPendingCitationInCollection();
    const seedB = await seedPendingCitationInCollection();

    const rows = await citationsAsync.listPending();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(seedA.citationId);
    expect(ids).toContain(seedB.citationId);
  });

  test('with collectionId opt, returns only pending citations in that collection', async () => {
    const seedA = await seedPendingCitationInCollection();
    const seedB = await seedPendingCitationInCollection();

    const rowsA = await citationsAsync.listPending({ collectionId: seedA.collectionId });
    const idsA = rowsA.map((r) => r.id);
    expect(idsA).toContain(seedA.citationId);
    expect(idsA).not.toContain(seedB.citationId);

    const rowsB = await citationsAsync.listPending({ collectionId: seedB.collectionId });
    const idsB = rowsB.map((r) => r.id);
    expect(idsB).toContain(seedB.citationId);
    expect(idsB).not.toContain(seedA.citationId);
  });

  test('only pending citations are returned (excludes approved/rejected)', async () => {
    const seed = await seedPendingCitationInCollection();
    // Approve the original citation, then add another pending to the same doc.
    await runAsync(`UPDATE citations SET approval_status = 'approved' WHERE id = ?`, [seed.citationId]);
    const newPendingId = await citationsAsync.create({
      entity_id: seed.entityId,
      transcript_id: seed.transcriptId,
      document_id: seed.documentId,
      passage_text: 'second pending',
      passage_start: 5,
      passage_end: 6,
      extraction_method: 'llm_auto',
      approval_status: 'pending'
    });

    const rows = await citationsAsync.listPending({ collectionId: seed.collectionId });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(newPendingId);
    expect(ids).not.toContain(seed.citationId);
    // every returned row should be pending
    for (const row of rows) {
      expect(row.approval_status).toBe('pending');
    }
  });
});
