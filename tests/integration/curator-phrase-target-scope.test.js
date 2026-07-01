'use strict';

// SECURITY-CRITICAL integration test for Task 4.5 — phrase-target promote
// scope filter.
//
// Per docs/superpowers/specs/2026-06-26-collection-scoped-knowledge-workbench-design.md
// § "Phrase-target promotion blast radius (highest-priority hazard)", the
// admin promote-to-entity handler UPDATEs every matching annotation across
// the corpus. When a collection-manager promotes a phrase, the UPDATE
// MUST be scoped to annotations in documents belonging to the manager's
// authorized collections only. Annotations of the same normalized phrase
// in other collections must remain phrase-targets, untouched.
//
// This test asserts the contract: collection-A manager promoting phrase X
// retargets A's annotations; B's annotations remain phrase-kind. If the
// scope filter regresses, this test fails and the PR cannot ship.

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqljs';

const request = require('supertest');
const express = require('express');
const { initApp } = require('../../server');
const db = require('../../database/db');
const {
  usersAsync,
  collectionsAsync,
  documentsAsync,
  documentCollectionsAsync,
  userCollectionAccessAsync,
  transcriptsAsync
} = require('../../database/db');

const phraseTargetsRouter = require('../../routes/admin-sentiment-phrase-targets');

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
  app.use('/admin/knowledge/sentiment/phrase-targets', phraseTargetsRouter);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function seedCollectionWithPhraseAnnotation(label, phrase) {
  const unique = `${Date.now()}-${label}-${Math.random().toString(36).slice(2, 8)}`;
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
    content: `transcript ${phrase} body`,
    transcriber: 'fixture',
    notes: null
  });
  // Manager grant
  await userCollectionAccessAsync.grant(userId, collectionId, 'manager');
  // Insert one phrase-target annotation directly. The schema requires
  // many fields; we fill them with safe minimums per the table's CHECK
  // constraints.
  const result = await db.runAsync(`
    INSERT INTO sentiment_annotations (
      transcript_id, document_id, span_start, span_end,
      evidence_excerpt, polarity, intensity, confidence,
      voice_role, target_kind, target_entity_id, target_phrase,
      emotion_phrase_verbatim, approval_status, auto_approved
    ) VALUES (?, ?, ?, ?, ?, 'neutral', 'low', 0.9, 'author',
              'phrase', NULL, ?, ?, 'approved', 0)
  `, [
    transcriptId,
    documentId,
    0,
    Math.max(1, phrase.length),
    `evidence with ${phrase}`,
    phrase,
    `verbatim ${phrase}`
  ]);
  return {
    userId,
    collectionId,
    documentId,
    transcriptId,
    annotationId: result.lastInsertRowid
  };
}

describe('Phrase-target promote: collection-scoped UPDATE (SECURITY-CRITICAL)', () => {
  let app;

  beforeAll(async () => {
    await initApp();
    app = buildAppWithFakeAuth();
  });

  test('manager promoting phrase in collection A does NOT touch annotations in collection B', async () => {
    const PHRASE = 'the schoolhouse';
    const A = await seedCollectionWithPhraseAnnotation('A', PHRASE);
    const B = await seedCollectionWithPhraseAnnotation('B', PHRASE);

    // Pre-check: both annotations exist as phrase-kind.
    const before = await db.allAsync(
      'SELECT id, target_kind, document_id FROM sentiment_annotations WHERE id IN (?, ?)',
      [A.annotationId, B.annotationId]
    );
    expect(before.every(r => r.target_kind === 'phrase')).toBe(true);

    // Act: collection-A manager promotes the phrase. The scope filter must
    // restrict the UPDATE to documents in A's collections only.
    const res = await request(app)
      .post('/admin/knowledge/sentiment/phrase-targets/promote')
      .set('x-user-id', String(A.userId))
      .set('x-user-role', 'user')
      .type('form')
      .send({
        phrase: PHRASE,
        phrase_normalized: PHRASE,
        entity_type: 'place',
        canonical_name: 'The Schoolhouse',
        // Pass the curator's own collection so the handler does not
        // additionally narrow via the optional collectionId form filter.
        // The middleware's req.curatorAllowedCollectionIds is the
        // authoritative scope.
        collectionId: String(A.collectionId)
      });
    expect([200, 302]).toContain(res.status);

    // Assert: A's annotation is now entity-kind; B's is still phrase-kind.
    const after = await db.allAsync(
      'SELECT id, target_kind, document_id, target_entity_id FROM sentiment_annotations WHERE id IN (?, ?) ORDER BY id',
      [A.annotationId, B.annotationId]
    );
    const aRow = after.find(r => r.id === A.annotationId);
    const bRow = after.find(r => r.id === B.annotationId);
    expect(aRow.target_kind).toBe('entity');
    expect(aRow.target_entity_id).not.toBeNull();
    // SECURITY CONTRACT: B is untouched.
    expect(bRow.target_kind).toBe('phrase');
    expect(bRow.target_entity_id).toBeNull();
  });

  test('admin promoting phrase retargets ALL matching annotations across collections', async () => {
    const PHRASE = 'the lighthouse';
    const A = await seedCollectionWithPhraseAnnotation('A2', PHRASE);
    const B = await seedCollectionWithPhraseAnnotation('B2', PHRASE);

    const res = await request(app)
      .post('/admin/knowledge/sentiment/phrase-targets/promote')
      .set('x-user-id', '1')
      .set('x-user-role', 'admin')
      .type('form')
      .send({
        phrase: PHRASE,
        phrase_normalized: PHRASE,
        entity_type: 'place',
        canonical_name: 'The Lighthouse'
      });
    expect([200, 302]).toContain(res.status);

    const after = await db.allAsync(
      'SELECT id, target_kind FROM sentiment_annotations WHERE id IN (?, ?)',
      [A.annotationId, B.annotationId]
    );
    // Admin path is corpus-wide: both are retargeted.
    expect(after.every(r => r.target_kind === 'entity')).toBe(true);
  });

  test('viewer role gets 404 from promote', async () => {
    const PHRASE = 'the gristmill';
    const A = await seedCollectionWithPhraseAnnotation('V', PHRASE);
    // Revoke manager to viewer
    await userCollectionAccessAsync.grant(A.userId, A.collectionId, 'viewer');

    const res = await request(app)
      .post('/admin/knowledge/sentiment/phrase-targets/promote')
      .set('x-user-id', String(A.userId))
      .set('x-user-role', 'user')
      .type('form')
      .send({
        phrase: PHRASE,
        phrase_normalized: PHRASE,
        entity_type: 'place',
        canonical_name: 'The Gristmill'
      });
    expect(res.status).toBe(404);
  });

  test('promote-existing gates and scopes the same way', async () => {
    const PHRASE = 'the chapel';
    const A = await seedCollectionWithPhraseAnnotation('A3', PHRASE);
    const B = await seedCollectionWithPhraseAnnotation('B3', PHRASE);
    // Create a target entity directly
    const entityId = await db.entitiesAsync.create({
      entity_type: 'place',
      canonical_name: 'The Chapel'
    });

    const res = await request(app)
      .post('/admin/knowledge/sentiment/phrase-targets/promote-existing')
      .set('x-user-id', String(A.userId))
      .set('x-user-role', 'user')
      .type('form')
      .send({
        phrase: PHRASE,
        phrase_normalized: PHRASE,
        entity_id: String(entityId)
      });
    expect([200, 302]).toContain(res.status);

    const after = await db.allAsync(
      'SELECT id, target_kind, target_entity_id FROM sentiment_annotations WHERE id IN (?, ?)',
      [A.annotationId, B.annotationId]
    );
    const aRow = after.find(r => r.id === A.annotationId);
    const bRow = after.find(r => r.id === B.annotationId);
    expect(aRow.target_kind).toBe('entity');
    expect(aRow.target_entity_id).toBe(entityId);
    // SECURITY CONTRACT
    expect(bRow.target_kind).toBe('phrase');
    expect(bRow.target_entity_id).toBeNull();
  });
});
