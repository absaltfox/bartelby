'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-jest-only-32ch';
process.env.DISABLE_BACKGROUND_WORKER = '1';
process.env.DATABASE_DRIVER = 'sqljs';
process.env.STORAGE_DRIVER = 'local';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-for-jest';

const request = require('supertest');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
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

async function seedCorpus(db) {
  // Collections — one world-public, one private.
  await db.runAsync(`INSERT INTO collections (id, name, is_world_public) VALUES (100, 'World Public', 1)`);
  await db.runAsync(`INSERT INTO collections (id, name) VALUES (200, 'Private')`);

  // Documents in each.
  await db.runAsync(`INSERT INTO documents (id, title, date_created, metadata) VALUES (1000, 'Public Letter', '1875-04-15', '{"author":"Alice"}')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1000, 1000, 'public letter content')`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1000, 100)`);

  await db.runAsync(`INSERT INTO documents (id, title, date_created, metadata) VALUES (2000, 'Private Letter', '1880-09-01', '{"author":"Bob"}')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (2000, 2000, 'private letter content')`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (2000, 200)`);

  // Labels + phrases.
  await db.runAsync(`INSERT INTO sentiment_phrase_labels (id, name) VALUES (1, 'grief')`);
  await db.runAsync(`INSERT INTO sentiment_emotion_phrases (id, phrase_text_normalized, canonical_label_id, usage_count) VALUES (1, 'distressed', 1, 1)`);

  // Annotations: one approved per doc, one pending on public, one rejected on public.
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_id, emotion_phrase_verbatim, approval_status, extracted_at)
     VALUES
       (1, 1000, 1000, 0, 10, 'in public', 'negative', 'moderate', 0.8, 'author', 'phrase', 'school',
        1, 'distressed', 'approved', '2026-01-01 00:00:00'),
       (2, 2000, 2000, 0, 10, 'in private','negative', 'moderate', 0.8, 'author', 'phrase', 'school',
        1, 'distressed', 'approved', '2026-01-02 00:00:00'),
       (3, 1000, 1000, 0, 10, 'pending row', 'negative', 'moderate', 0.6, 'author', 'phrase', 'school',
        1, 'distressed', 'pending',  '2026-01-03 00:00:00'),
       (4, 1000, 1000, 0, 10, 'rejected row','negative','moderate', 0.8, 'author', 'phrase', 'school',
        1, 'distressed', 'rejected', '2026-01-04 00:00:00')`
  );
}

describe('/sentiment research routes', () => {
  let app;
  let db;
  let adminAgent;

  beforeAll(async () => {
    jest.resetModules();
    const { app: initializedApp, initApp } = require('../../server');
    await initApp();
    app = initializedApp;
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

    await seedCorpus(db);

    adminAgent = request.agent(app);
    await loginAsAdmin(adminAgent);
  }, 180_000);

  describe('GET /sentiment/annotations.json', () => {
    it('anonymous viewer only sees annotations in is_world_public collections', async () => {
      const res = await request(app).get('/sentiment/annotations.json');
      expect(res.status).toBe(200);
      const docIds = res.body.rows.map(r => r.document_id);
      expect(docIds).toContain(1000);
      expect(docIds).not.toContain(2000);
    });

    it('anonymous viewer sees only approved (no pending or rejected)', async () => {
      const res = await request(app).get('/sentiment/annotations.json');
      const statuses = new Set(res.body.rows.map(r => r.approval_status));
      expect(statuses).toEqual(new Set(['approved']));
    });

    it('admin sees annotations across all collections', async () => {
      const res = await adminAgent.get('/sentiment/annotations.json');
      expect(res.status).toBe(200);
      const docIds = res.body.rows.map(r => r.document_id);
      expect(docIds).toContain(1000);
      expect(docIds).toContain(2000);
    });

    it('admin status=pending returns only pending', async () => {
      const res = await adminAgent.get('/sentiment/annotations.json?status=pending');
      expect(res.status).toBe(200);
      const ids = res.body.rows.map(r => r.id);
      expect(ids).toEqual([3]);
    });

    it('non-admin (anonymous) status=pending → 400', async () => {
      const res = await request(app).get('/sentiment/annotations.json?status=pending');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/admin/);
    });

    it('plutchik filter → 400 (internal-only invariant)', async () => {
      const res = await request(app).get('/sentiment/annotations.json?plutchik=joy');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/plutchik/i);
    });

    it('rejected is never visible, even to admin filtering by approved status', async () => {
      const res = await adminAgent.get('/sentiment/annotations.json');
      const statuses = new Set(res.body.rows.map(r => r.approval_status));
      expect(statuses.has('rejected')).toBe(false);
    });

    it('cursor pagination returns has_more and a next cursor', async () => {
      const first = await adminAgent.get('/sentiment/annotations.json?limit=1');
      expect(first.body.rows).toHaveLength(1);
      expect(first.body.has_more).toBe(true);
      expect(first.body.next_cursor).toBeTruthy();
      const second = await adminAgent.get(`/sentiment/annotations.json?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`);
      expect(second.body.rows).toHaveLength(1);
      expect(second.body.rows[0].id).not.toBe(first.body.rows[0].id);
    });
  });

  describe('GET /sentiment/rollups.json', () => {
    it('shape=summary returns label rollups', async () => {
      const res = await adminAgent.get('/sentiment/rollups.json?shape=summary');
      expect(res.status).toBe(200);
      expect(res.body.shape).toBe('summary');
      const grief = res.body.rows.find(r => r.label_name === 'grief');
      expect(grief).toBeDefined();
      expect(grief.annotation_count).toBe(2); // two approved across both docs
    });

    it('shape=timeline accepts bucket parameter', async () => {
      const res = await adminAgent.get('/sentiment/rollups.json?shape=timeline&bucket=decade');
      expect(res.status).toBe(200);
      expect(res.body.bucket).toBe('decade');
      const keys = res.body.rows.map(r => r.bucket_key);
      expect(keys).toContain('1870');
      expect(keys).toContain('1880');
    });

    it('shape=cooccurrence without entity_id → 400', async () => {
      const res = await adminAgent.get('/sentiment/rollups.json?shape=cooccurrence');
      expect(res.status).toBe(400);
    });

    it('shape=fingerprint includes text-grouped caveat', async () => {
      const res = await adminAgent.get('/sentiment/rollups.json?shape=fingerprint');
      expect(res.status).toBe(200);
      expect(res.body.caveat).toBe('text-grouped');
    });

    it('unknown shape → 400', async () => {
      const res = await adminAgent.get('/sentiment/rollups.json?shape=mystery');
      expect(res.status).toBe(400);
    });

    it('anonymous rollups only count approved + world_public', async () => {
      const res = await request(app).get('/sentiment/rollups.json?shape=summary');
      expect(res.status).toBe(200);
      const grief = res.body.rows.find(r => r.label_name === 'grief');
      // Only the one approved annotation in the world_public doc is visible.
      expect(grief.annotation_count).toBe(1);
      expect(grief.document_count).toBe(1);
    });
  });
});
