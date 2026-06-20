'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/meta name="csrf-token" content="([^"]+)"/);
  return match ? match[1] : null;
}

let app;
let db;
let adminAgent;
let csrfToken;
const DOC_ID = 5101;
const TRANSCRIPT_CONTENT = 'I love the school house where I once worked. The school house was warm.';

beforeAll(async () => {
  jest.resetModules();
  const { app: a, initApp } = require('../../server');
  await initApp();
  app = a;
  db = require('../../database/db');

  const setupAgent = request.agent(app);
  const setupPage = await setupAgent.get('/setup');
  const setupCsrf = extractCsrfToken(setupPage.text);
  await setupAgent.post('/setup').type('form').send({
    username: 's3promoteadmin',
    password: 'pw-abcdefgh99!',
    confirm: 'pw-abcdefgh99!',
    bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
    _csrf: setupCsrf
  });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  await adminAgent.post('/login').type('form').send({
    username: 's3promoteadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf
  });

  await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [DOC_ID, 'Promote Test Doc']);
  await db.runAsync(`INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`, [DOC_ID, DOC_ID, TRANSCRIPT_CONTENT]);
  for (let i = 0; i < 2; i++) {
    await db.runAsync(`INSERT INTO sentiment_annotations
      (transcript_id, document_id, span_start, span_end, evidence_excerpt,
       polarity, intensity, voice_role, target_kind, target_phrase, emotion_phrase_verbatim)
      VALUES (?, ?, ?, ?, ?, 'positive', 'strong', 'author', 'phrase', 'the school house', 'love')`,
      [DOC_ID, DOC_ID, 7, 23, 'the school house']);
  }

  const formPage = await adminAgent.get('/admin/knowledge/sentiment/phrase-targets');
  csrfToken = extractCsrfToken(formPage.text);
}, 60_000);

describe('POST /admin/knowledge/sentiment/phrase-targets/promote', () => {
  it('only re-targets annotations inside the visible collection and polarity scope', async () => {
    const scopedPhrase = 'scoped schoolhouse';
    const scopedCollectionId = await db.collectionsAsync.create({
      name: 'Scoped Phrase Promotion',
      description: null,
      is_public: false,
      is_world_public: false,
      allow_export: false,
      auto_group_pages: false
    });
    const inScopeDocId = 5102;
    const outOfScopeDocId = 5103;
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [inScopeDocId, 'Scoped Phrase In']);
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (?, ?)`, [outOfScopeDocId, 'Scoped Phrase Out']);
    await db.runAsync(`INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`, [inScopeDocId, inScopeDocId, scopedPhrase]);
    await db.runAsync(`INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (?, ?, ?)`, [outOfScopeDocId, outOfScopeDocId, scopedPhrase]);
    await db.documentCollectionsAsync.add(inScopeDocId, scopedCollectionId);

    await db.runAsync(`INSERT INTO sentiment_annotations
      (transcript_id, document_id, span_start, span_end, evidence_excerpt,
       polarity, intensity, voice_role, target_kind, target_phrase, emotion_phrase_verbatim)
      VALUES (?, ?, 0, 18, ?, 'positive', 'moderate', 'author', 'phrase', ?, 'admired')`,
      [inScopeDocId, inScopeDocId, scopedPhrase, scopedPhrase]);
    await db.runAsync(`INSERT INTO sentiment_annotations
      (transcript_id, document_id, span_start, span_end, evidence_excerpt,
       polarity, intensity, voice_role, target_kind, target_phrase, emotion_phrase_verbatim)
      VALUES (?, ?, 0, 18, ?, 'negative', 'moderate', 'author', 'phrase', ?, 'doubted')`,
      [inScopeDocId, inScopeDocId, scopedPhrase, scopedPhrase]);
    await db.runAsync(`INSERT INTO sentiment_annotations
      (transcript_id, document_id, span_start, span_end, evidence_excerpt,
       polarity, intensity, voice_role, target_kind, target_phrase, emotion_phrase_verbatim)
      VALUES (?, ?, 0, 18, ?, 'positive', 'moderate', 'author', 'phrase', ?, 'admired')`,
      [outOfScopeDocId, outOfScopeDocId, scopedPhrase, scopedPhrase]);

    const res = await adminAgent
      .post('/admin/knowledge/sentiment/phrase-targets/promote')
      .type('form')
      .send({
        _csrf: csrfToken,
        phrase: scopedPhrase,
        phrase_normalized: scopedPhrase,
        collectionId: scopedCollectionId,
        polarity: 'positive',
        entity_type: 'place',
        canonical_name: 'Scoped Schoolhouse Entity'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/saved=1/);

    const entity = await db.getAsync(`SELECT * FROM entities WHERE canonical_name = 'Scoped Schoolhouse Entity'`);
    expect(entity).toBeTruthy();

    const annotations = await db.allAsync(
      `SELECT document_id, polarity, target_kind, target_entity_id
       FROM sentiment_annotations
       WHERE target_phrase = ?
       ORDER BY document_id ASC, polarity ASC`,
      [scopedPhrase]
    );
    expect(annotations.filter((row) => row.target_kind === 'entity')).toEqual([
      expect.objectContaining({ document_id: inScopeDocId, polarity: 'positive', target_entity_id: entity.id })
    ]);
    expect(annotations.filter((row) => row.target_kind === 'phrase')).toEqual([
      expect.objectContaining({ document_id: inScopeDocId, polarity: 'negative', target_entity_id: null }),
      expect.objectContaining({ document_id: outOfScopeDocId, polarity: 'positive', target_entity_id: null })
    ]);

    const citations = await db.allAsync(`SELECT document_id, passage_text FROM citations WHERE entity_id = ?`, [entity.id]);
    expect(citations).toEqual([{ document_id: inScopeDocId, passage_text: scopedPhrase }]);
  });

  it('creates the entity, re-targets matching annotations, and derives citations', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/phrase-targets/promote')
      .type('form')
      .send({
        _csrf: csrfToken,
        phrase: 'the school house',
        entity_type: 'place',
        canonical_name: 'The School House'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/saved=1/);

    const entity = await db.getAsync(`SELECT * FROM entities WHERE canonical_name = 'The School House'`);
    expect(entity).toBeTruthy();
    expect(entity.entity_type).toBe('place');

    const reTargeted = await db.allAsync(
      `SELECT target_kind, target_entity_id, target_phrase FROM sentiment_annotations
       WHERE LOWER(TRIM(target_phrase)) = 'the school house'`
    );
    expect(reTargeted.length).toBe(2);
    reTargeted.forEach((row) => {
      expect(row.target_kind).toBe('entity');
      expect(row.target_entity_id).toBe(entity.id);
      expect(row.target_phrase).toBe('the school house');
    });

    const citations = await db.allAsync(
      `SELECT * FROM citations WHERE entity_id = ?`,
      [entity.id]
    );
    expect(citations.length).toBe(2);
    citations.forEach((c) => {
      expect(c.extraction_method).toBe('manual');
      expect(c.approval_status).toBe('approved');
      expect(c.passage_text).toBe('the school house');
    });
  });

  it('rejects an invalid entity_type', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/phrase-targets/promote')
      .type('form')
      .send({
        _csrf: csrfToken,
        phrase: 'the school house',
        entity_type: 'not-a-real-type',
        canonical_name: 'X'
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });

  it('rejects an empty canonical_name', async () => {
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/phrase-targets/promote')
      .type('form')
      .send({
        _csrf: csrfToken,
        phrase: 'another phrase',
        entity_type: 'topic',
        canonical_name: ''
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });
});
