'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';

const {
  authorityLinkSuggestionsAsync,
  authoritiesAsync,
  citationsAsync,
  entitiesAsync,
  documentsAsync,
  transcriptsAsync,
  collectionsAsync,
  documentCollectionsAsync,
  usersAsync
} = require('../../database/db');
const { initApp } = require('../../server');

// Authority link suggestions reference the entity by entity_id; the
// resolution chain to a collection is therefore:
//   suggestion.entity_id -> citations.entity_id -> citations.document_id
//   -> document_collections.collection_id
// (Entities have no document_id column — see migrations.js v44 — so the
// hop has to go through citations.)
async function seedPendingAuthoritySuggestionInCollection() {
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
  const authorityId = await authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: `A-${unique}`,
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });
  const suggestionId = await authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: entityId,
    suggested_authority_id: authorityId,
    confidence: 0.9,
    match_method: 'fixture',
    status: 'pending'
  });
  return { userId, collectionId, documentId, transcriptId, entityId, authorityId, suggestionId };
}

describe('authorityLinkSuggestionsAsync.listPending — collectionId scope', () => {
  beforeAll(async () => { await initApp(); });

  test('without collectionId opt, returns pending suggestions from any collection', async () => {
    const a = await seedPendingAuthoritySuggestionInCollection();
    const b = await seedPendingAuthoritySuggestionInCollection();

    const rows = await authorityLinkSuggestionsAsync.listPending();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.suggestionId);
    expect(ids).toContain(b.suggestionId);
  });

  test('with collectionId opt, returns only suggestions tied to entities in that collection', async () => {
    const a = await seedPendingAuthoritySuggestionInCollection();
    const b = await seedPendingAuthoritySuggestionInCollection();

    const rowsA = await authorityLinkSuggestionsAsync.listPending({ collectionId: a.collectionId });
    const idsA = rowsA.map((r) => r.id);
    expect(idsA).toContain(a.suggestionId);
    expect(idsA).not.toContain(b.suggestionId);

    const rowsB = await authorityLinkSuggestionsAsync.listPending({ collectionId: b.collectionId });
    const idsB = rowsB.map((r) => r.id);
    expect(idsB).toContain(b.suggestionId);
    expect(idsB).not.toContain(a.suggestionId);
  });

  test('returned rows are all pending', async () => {
    const a = await seedPendingAuthoritySuggestionInCollection();
    const rows = await authorityLinkSuggestionsAsync.listPending({ collectionId: a.collectionId });
    for (const row of rows) {
      expect(row.status).toBe('pending');
    }
  });
});
