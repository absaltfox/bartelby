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

async function seedDocuments(db) {
  // World-public collection so anonymous tests work.
  await db.runAsync(`INSERT INTO collections (id, name, is_world_public) VALUES (100, 'World Public', 1)`);

  // Doc with approved sentiment.
  await db.runAsync(`INSERT INTO documents (id, title) VALUES (1001, 'Letter with sentiment')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content, is_best) VALUES (1001, 1001, 'Sir, I was deeply distressed by the news of the school house.', 1)`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1001, 100)`);

  // Doc with only pending sentiment — should hide the tab for anonymous.
  await db.runAsync(`INSERT INTO documents (id, title) VALUES (1002, 'Pending-only letter')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content, is_best) VALUES (1002, 1002, 'A second letter.', 1)`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1002, 100)`);

  // Doc with no sentiment at all.
  await db.runAsync(`INSERT INTO documents (id, title) VALUES (1003, 'Procedural letter')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content, is_best) VALUES (1003, 1003, 'A purely procedural report.', 1)`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1003, 100)`);

  // Label + phrase shared across annotations.
  await db.runAsync(`INSERT INTO sentiment_phrase_labels (id, name) VALUES (1, 'grief')`);
  await db.runAsync(`INSERT INTO sentiment_emotion_phrases (id, phrase_text_normalized, canonical_label_id, usage_count) VALUES (1, 'distressed', 1, 1)`);

  // Approved annotation on doc 1001.
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_id, emotion_phrase_verbatim, approval_status, extracted_at)
     VALUES
       (1, 1001, 1001, 13, 30, 'deeply distressed by the news', 'negative', 'strong', 0.92,
        'author', 'phrase', 'the news', 1, 'deeply distressed', 'approved', '2026-01-01 00:00:00')`
  );

  // Pending-only on doc 1002 — invisible to anonymous viewers.
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_id, emotion_phrase_verbatim, approval_status, extracted_at)
     VALUES
       (2, 1002, 1002, 0, 5, 'pending row', 'negative', 'moderate', 0.6,
        'author', 'phrase', 'school', 1, 'distressed', 'pending', '2026-01-02 00:00:00')`
  );
}

describe('Document Sentiment tab (Phase 4 slice 3)', () => {
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

    await seedDocuments(db);

    adminAgent = request.agent(app);
    await loginAsAdmin(adminAgent);
  }, 180_000);

  describe('tab visibility', () => {
    it('shows the Sentiment tab when the document has approved sentiment (anonymous)', async () => {
      const res = await request(app).get('/documents/1001');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/data-tab="sentiment"/);
      expect(res.text).toMatch(/id="tab-sentiment"/);
    });

    it('hides the Sentiment tab when the document has no approved sentiment (anonymous)', async () => {
      const res = await request(app).get('/documents/1002');
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/data-tab="sentiment"/);
      expect(res.text).not.toMatch(/id="tab-sentiment"/);
    });

    it('hides the Sentiment tab when the document has no sentiment at all', async () => {
      const res = await request(app).get('/documents/1003');
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/data-tab="sentiment"/);
    });

    it('admin sees the Sentiment tab even when only approved exists (no pending opt-in needed)', async () => {
      const res = await adminAgent.get('/documents/1001');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/data-tab="sentiment"/);
    });
  });

  describe('bootstrap and script loading', () => {
    it('emits a window.__sentimentDocumentTab bootstrap with the document id', async () => {
      const res = await request(app).get('/documents/1001');
      expect(res.text).toMatch(/window\.__sentimentDocumentTab\s*=\s*\{[\s\S]*?documentId:\s*1001/);
    });

    it('loads the shared card renderer + the document tab script', async () => {
      const res = await request(app).get('/documents/1001');
      expect(res.text).toContain('/js/sentiment-card-renderer.js');
      expect(res.text).toContain('/js/sentiment-document-tab.js');
    });

    it('does not load the document-tab script when the tab is hidden', async () => {
      const res = await request(app).get('/documents/1003');
      expect(res.text).not.toContain('/js/sentiment-document-tab.js');
      expect(res.text).not.toMatch(/window\.__sentimentDocumentTab/);
    });
  });

  describe('SSR panel contents', () => {
    it('renders the label distribution panel inside the tab', async () => {
      const res = await request(app).get('/documents/1001');
      expect(res.text).toMatch(/id="tab-sentiment"[\s\S]*Label distribution/);
      expect(res.text).toMatch(/id="tab-sentiment"[\s\S]*s-panel-row-label[^>]*>\s*grief/);
    });

    it('mounts the lazy-load placeholder for annotation cards', async () => {
      const res = await request(app).get('/documents/1001');
      expect(res.text).toMatch(/data-sentiment-doc-list/);
      expect(res.text).toMatch(/aria-busy="true"/);
    });
  });

  describe('document_id filter on /sentiment/annotations.json', () => {
    it('limits results to the requested document (anonymous)', async () => {
      const res = await request(app).get('/sentiment/annotations.json?document_id=1001');
      expect(res.status).toBe(200);
      const ids = res.body.rows.map(r => r.document_id);
      expect(new Set(ids).size === 1 && ids[0] === 1001).toBe(true);
    });

    it('returns an empty list when filtered by a document with no approved sentiment', async () => {
      const res = await request(app).get('/sentiment/annotations.json?document_id=1002');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(0);
    });
  });
});
