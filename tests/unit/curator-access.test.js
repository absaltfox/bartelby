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
  dateExpressionsAsync,
  authorityLinkSuggestionsAsync,
  authoritiesAsync,
  runAsync,
  normalizeSentimentPhrase
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

// Seed an authority + authority_link_suggestion hanging off the entity from
// seedEntityInCollection. The suggestion's entity_id field is the resolution
// handle the predicate uses to reach the entity → citations → collections
// chain.
async function seedAuthoritySuggestionInCollection({ userRole = 'manager' } = {}) {
  const seed = await seedEntityInCollection({ userRole });
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const authorityId = await authoritiesAsync.create({
    authority_type: 'person',
    canonical_name: `A-${unique}`,
    description: null,
    properties: {},
    external_source: null,
    external_key: null
  });
  const suggestionId = await authorityLinkSuggestionsAsync.createIfMissing({
    entity_id: seed.entityId,
    suggested_authority_id: authorityId,
    confidence: 0.9,
    match_method: 'fixture',
    status: 'pending'
  });
  return { ...seed, authorityId, suggestionId };
}

// Seed a phrase-target sentiment_annotations row attached to the document
// from seedEntityInCollection. The predicate resolves the phrase to the
// collections that contain matching annotations (via the
// annotations.document_id → document_collections chain), so the fixture
// needs the row to share document_id with the seed document. The phrase
// is normalized via the same normalizeSentimentPhrase the existing admin
// promote handler uses (LOWER + RTRIM trailing punctuation + collapse
// whitespace), so the predicate sees the same set the eventual handler
// will UPDATE.
async function seedPhraseTargetInCollection({ userRole = 'manager', phrase = 'the schoolhouse' } = {}) {
  const seed = await seedEntityInCollection({ userRole });
  await runAsync(
    `INSERT INTO sentiment_annotations (
       transcript_id, document_id, span_start, span_end, evidence_excerpt,
       polarity, intensity, confidence, voice_role, target_kind,
       target_phrase, emotion_phrase_verbatim, approval_status
     ) VALUES (?, ?, 0, 1, 'fixture', 'positive', 'low', 0.5, 'author', 'phrase', ?, 'love', 'approved')`,
    [seed.transcriptId, seed.documentId, phrase]
  );
  return { ...seed, phrase };
}

// Add a second phrase-target annotation to the existing seed's document,
// useful for cross-collection leakage tests where collection A contains the
// promotable annotation and collection B contains an annotation of the same
// phrase the curator should NOT be allowed to mutate.
async function addPhraseTargetToCollection({ collectionId, phrase, userRole = 'viewer' }) {
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
    content: 'fixture transcript',
    transcriber: 'fixture',
    notes: null
  });
  await runAsync(
    `INSERT INTO sentiment_annotations (
       transcript_id, document_id, span_start, span_end, evidence_excerpt,
       polarity, intensity, confidence, voice_role, target_kind,
       target_phrase, emotion_phrase_verbatim, approval_status
     ) VALUES (?, ?, 0, 1, 'fixture', 'positive', 'low', 0.5, 'author', 'phrase', ?, 'love', 'approved')`,
    [transcriptId, documentId, phrase]
  );
  return { documentId, transcriptId };
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

  test('cached lookup returns same result without re-querying', async () => {
    const { user, entityId } = await seedEntityInCollection({ userRole: 'manager' });
    const cache = new Map();
    const r1 = await curatorAccessAsync.userCanCurateEntity(user, entityId, { cache });
    const r2 = await curatorAccessAsync.userCanCurateEntity(user, entityId, { cache });
    expect(r2).toBe(r1);  // same object reference -> served from cache
  });

  test('rejected predicate is cleared from cache so subsequent calls retry', async () => {
    const { user, entityId } = await seedEntityInCollection({ userRole: 'manager' });
    const cache = new Map();
    const originalGetById = entitiesAsync.getById;
    let callCount = 0;
    entitiesAsync.getById = async function (id) {
      callCount += 1;
      if (callCount === 1) throw new Error('synthetic transient failure');
      return originalGetById.call(this, id);
    };
    try {
      await expect(
        curatorAccessAsync.userCanCurateEntity(user, entityId, { cache })
      ).rejects.toThrow('synthetic transient failure');
      // Cache entry must have been cleared, so the next call hits the (now successful) underlying lookup.
      const recovered = await curatorAccessAsync.userCanCurateEntity(user, entityId, { cache });
      expect(recovered.allowed).toBe(true);
      expect(callCount).toBe(2);
    } finally {
      entitiesAsync.getById = originalGetById;
    }
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

describe('curatorAccessAsync.userCanCurateAuthoritySuggestion', () => {
  beforeAll(async () => { await initApp(); });

  test('admin is always allowed', async () => {
    const result = await curatorAccessAsync.userCanCurateAuthoritySuggestion(
      { id: 1, role: 'admin' },
      9999
    );
    expect(result).toEqual({ allowed: true, collectionIds: null });
  });

  test("manager on the suggestion's entity collection is allowed", async () => {
    const { user, suggestionId, collectionId } = await seedAuthoritySuggestionInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateAuthoritySuggestion(user, suggestionId);
    expect(result.allowed).toBe(true);
    expect(result.collectionIds).toContain(collectionId);
  });

  test("viewer on the suggestion's entity collection is denied", async () => {
    const { user, suggestionId } = await seedAuthoritySuggestionInCollection({ userRole: 'viewer' });
    const result = await curatorAccessAsync.userCanCurateAuthoritySuggestion(user, suggestionId);
    expect(result.allowed).toBe(false);
  });

  test('manager on a different collection is denied', async () => {
    const { user } = await seedAuthoritySuggestionInCollection({ userRole: 'manager' });
    const other = await seedAuthoritySuggestionInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateAuthoritySuggestion(user, other.suggestionId);
    expect(result.allowed).toBe(false);
  });

  test('non-existent suggestion returns same shape as forbidden', async () => {
    const { user } = await seedAuthoritySuggestionInCollection({ userRole: 'manager' });
    const result = await curatorAccessAsync.userCanCurateAuthoritySuggestion(user, 9999999);
    expect(result.allowed).toBe(false);
  });
});

// Phrase-target predicate has a different shape: it takes a normalized phrase
// string (not an id) and resolves via sentiment_annotations.target_phrase →
// document_collections. The `collectionIds` in the result is the
// INTERSECTION of (collections containing matching annotations) ∩
// (collections where the user holds manager-or-higher). The eventual
// promote/suppress handler in PR 4 will use that list to scope a corpus-wide
// UPDATE down to authorized collections only — see spec § "Phrase-target
// scope" and § "Phrase-target promotion blast radius".
describe('curatorAccessAsync.userCanCuratePhraseTarget', () => {
  beforeAll(async () => { await initApp(); });

  test('admin is always allowed and gets short-circuit shape', async () => {
    const result = await curatorAccessAsync.userCanCuratePhraseTarget(
      { id: 1, role: 'admin' },
      'anything'
    );
    expect(result).toEqual({ allowed: true, collectionIds: null });
  });

  test("manager whose collection contains matching annotations is allowed and gets that collection's id", async () => {
    const phrase = `fixture-phrase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { user, collectionId } = await seedPhraseTargetInCollection({ userRole: 'manager', phrase });
    const normalized = normalizeSentimentPhrase(phrase);
    const result = await curatorAccessAsync.userCanCuratePhraseTarget(user, normalized);
    expect(result.allowed).toBe(true);
    expect(result.collectionIds).toEqual([collectionId]);
  });

  test('manager whose collection has NO matching annotations is denied', async () => {
    const phrase = `fixture-phrase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Seed phrase in some collection, then test against a DIFFERENT manager user.
    await seedPhraseTargetInCollection({ userRole: 'manager', phrase });
    const { user } = await seedEntityInCollection({ userRole: 'manager' });
    const normalized = normalizeSentimentPhrase(phrase);
    const result = await curatorAccessAsync.userCanCuratePhraseTarget(user, normalized);
    expect(result.allowed).toBe(false);
  });

  test('multi-collection: collection A (manager) plus collection B (viewer) → only A returned, B not leaked', async () => {
    const phrase = `fixture-phrase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Collection A: user is manager; phrase appears here.
    const seedA = await seedPhraseTargetInCollection({ userRole: 'manager', phrase });
    // Collection B: same user is viewer; phrase ALSO appears here.
    const seedB = await seedEntityInCollection({ userRole: 'viewer' });
    // Grant the same user viewer on B (already done by the seed) and seed the
    // phrase into B's document so the corpus-wide row set contains both
    // collections. Then re-grant the same user viewer on B explicitly
    // (the seed creates a new user; we need our user from A on B as viewer).
    await userCollectionAccessAsync.grant(seedA.user.id, seedB.collectionId, 'viewer');
    await addPhraseTargetToCollection({
      collectionId: seedB.collectionId,
      phrase
    });
    const normalized = normalizeSentimentPhrase(phrase);
    const result = await curatorAccessAsync.userCanCuratePhraseTarget(seedA.user, normalized);
    expect(result.allowed).toBe(true);
    expect(result.collectionIds).toEqual([seedA.collectionId]);
    expect(result.collectionIds).not.toContain(seedB.collectionId);
  });

  test('empty or missing phrase string returns forbidden', async () => {
    const { user } = await seedEntityInCollection({ userRole: 'manager' });
    expect((await curatorAccessAsync.userCanCuratePhraseTarget(user, '')).allowed).toBe(false);
    expect((await curatorAccessAsync.userCanCuratePhraseTarget(user, null)).allowed).toBe(false);
    expect((await curatorAccessAsync.userCanCuratePhraseTarget(user, undefined)).allowed).toBe(false);
  });
});
