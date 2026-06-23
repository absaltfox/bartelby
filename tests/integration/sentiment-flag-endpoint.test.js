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

async function loginAsAdmin(agent) {
  const page = await agent.get('/login');
  const csrf = extractCsrfToken(page.text);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ username: 'testadmin', password: 'testpassword99!', _csrf: csrf });
  expect(res.status).toBe(302);
}

async function getCsrfFromMeta(agent, path) {
  const res = await agent.get(path);
  const m = res.text.match(/meta name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : null;
}

async function seed(db) {
  await db.runAsync(`INSERT INTO collections (id, name, is_world_public) VALUES (100, 'World Public', 1)`);
  await db.runAsync(`INSERT INTO documents (id, title) VALUES (1000, 'Letter')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content, is_best) VALUES (1000, 1000, 'sample', 1)`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1000, 100)`);
  await db.runAsync(`INSERT INTO sentiment_phrase_labels (id, name) VALUES (1, 'grief')`);
  await db.runAsync(`INSERT INTO sentiment_emotion_phrases (id, phrase_text_normalized, canonical_label_id, usage_count) VALUES (1, 'distressed', 1, 1)`);

  // Three rows in three different states.
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_id, emotion_phrase_verbatim, approval_status, extracted_at)
     VALUES
       (1, 1000, 1000, 0, 5, 'approved row', 'negative', 'low', 0.8, 'author', 'phrase', 'x', 1, 'distressed', 'approved', '2026-01-01 00:00:00'),
       (2, 1000, 1000, 0, 5, 'pending row',  'negative', 'low', 0.6, 'author', 'phrase', 'x', 1, 'distressed', 'pending',  '2026-01-02 00:00:00'),
       (3, 1000, 1000, 0, 5, 'rejected row', 'negative', 'low', 0.6, 'author', 'phrase', 'x', 1, 'distressed', 'rejected', '2026-01-03 00:00:00')`
  );
}

describe('POST /admin/knowledge/sentiment/annotations/:id/flag', () => {
  let app;
  let db;
  let adminAgent;

  beforeAll(async () => {
    jest.resetModules();
    const { app: a, initApp } = require('../../server');
    await initApp();
    app = a;
    db = require('../../database/db');

    const setupAgent = request.agent(app);
    const setupPage = await setupAgent.get('/setup');
    const setupCsrf = extractCsrfToken(setupPage.text);
    await setupAgent
      .post('/setup')
      .type('form')
      .send({
        username: 'testadmin',
        password: 'testpassword99!',
        confirm: 'testpassword99!',
        bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
        _csrf: setupCsrf
      });

    await seed(db);

    adminAgent = request.agent(app);
    await loginAsAdmin(adminAgent);
  }, 180_000);

  it('admin flags an approved annotation → flips to pending with a review_note', async () => {
    const csrf = await getCsrfFromMeta(adminAgent, '/admin/knowledge/sentiment/review');
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/annotations/1/flag')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send({ surface: '/sentiment' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, annotationId: 1 });

    const row = await db.getAsync(`SELECT approval_status, review_note, reviewed_by FROM sentiment_annotations WHERE id = 1`);
    expect(row.approval_status).toBe('pending');
    expect(row.review_note).toMatch(/Flagged for review from \/sentiment/);
    expect(row.reviewed_by).toBeTruthy();
  });

  it('409 when the annotation is already pending', async () => {
    const csrf = await getCsrfFromMeta(adminAgent, '/admin/knowledge/sentiment/review');
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/annotations/2/flag')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Only approved annotations/);
  });

  it('409 when the annotation is rejected', async () => {
    const csrf = await getCsrfFromMeta(adminAgent, '/admin/knowledge/sentiment/review');
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/annotations/3/flag')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(409);
  });

  it('404 when the annotation does not exist', async () => {
    const csrf = await getCsrfFromMeta(adminAgent, '/admin/knowledge/sentiment/review');
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/annotations/9999/flag')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(404);
  });

  it('400 when the id is not an integer', async () => {
    const csrf = await getCsrfFromMeta(adminAgent, '/admin/knowledge/sentiment/review');
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/annotations/abc/flag')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
  });

  it('anonymous viewer is redirected to login (admin gate)', async () => {
    const res = await request(app)
      .post('/admin/knowledge/sentiment/annotations/1/flag')
      .set('Content-Type', 'application/json')
      .send({});
    expect([302, 401, 403]).toContain(res.status);
  });

  it('CSRF protection blocks requests without a valid token', async () => {
    // Re-seed approved row #1 since the first test flipped it to pending.
    await db.runAsync(`UPDATE sentiment_annotations SET approval_status = 'approved' WHERE id = 1`);
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/annotations/1/flag')
      .set('Content-Type', 'application/json')
      // deliberately no X-CSRF-Token header
      .send({});
    // CSRF failure in this app surfaces as either a 4xx JSON error or a
    // 302 redirect depending on which middleware fires first. The point
    // is that the request is NOT a success.
    expect(res.status).not.toBe(200);
    expect([302, 400, 403]).toContain(res.status);
    // And the row stays approved.
    const row = await db.getAsync(`SELECT approval_status FROM sentiment_annotations WHERE id = 1`);
    expect(row.approval_status).toBe('approved');
  });

  it('reason is captured in the review_note when provided', async () => {
    // Re-seed approved row.
    await db.runAsync(`UPDATE sentiment_annotations SET approval_status = 'approved' WHERE id = 1`);
    const csrf = await getCsrfFromMeta(adminAgent, '/admin/knowledge/sentiment/review');
    const res = await adminAgent
      .post('/admin/knowledge/sentiment/annotations/1/flag')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'application/json')
      .send({ surface: '/sentiment', reason: 'wrong voice role' });
    expect(res.status).toBe(200);
    const row = await db.getAsync(`SELECT review_note FROM sentiment_annotations WHERE id = 1`);
    expect(row.review_note).toMatch(/Flagged for review from \/sentiment: wrong voice role/);
  });
});
