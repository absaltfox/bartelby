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

async function seed(db) {
  await db.runAsync(`INSERT INTO collections (id, name, is_world_public) VALUES (100, 'Letters', 1)`);
  // Second collection — sentiment but NO analytics; tests the
  // "Sentiment subtab without BERTopic" plan goal.
  await db.runAsync(`INSERT INTO collections (id, name, is_world_public) VALUES (101, 'Sentiment-only', 1)`);
  await db.runAsync(`INSERT INTO documents (id, title) VALUES (1000, 'Letter A')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content, is_best) VALUES (1000, 1000, 'sample', 1)`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1000, 100)`);
  await db.runAsync(`INSERT INTO documents (id, title) VALUES (1001, 'Letter B')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content, is_best) VALUES (1001, 1001, 'second', 1)`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1001, 101)`);

  await db.runAsync(`INSERT INTO sentiment_phrase_labels (id, name) VALUES (1, 'gratitude')`);
  await db.runAsync(`INSERT INTO sentiment_emotion_phrases (id, phrase_text_normalized, canonical_label_id, usage_count) VALUES (1, 'thankful', 1, 1)`);

  // Flagged-and-returned-to-pending row in collection 100, with a Phase 4
  // review_note that the curator-queue notice should surface.
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_id, emotion_phrase_verbatim, approval_status,
        review_note, extracted_at)
     VALUES (1, 1000, 1000, 0, 8, 'thankful for the schoolhouse', 'positive',
       'moderate', 0.9, 'author', 'phrase', 'the schoolhouse', 1, 'thankful',
       'pending', 'Flagged for review from /sentiment: wrong voice role',
       '2026-01-01 00:00:00')`
  );
  // A plain pending row without a flag-note — must NOT show the notice.
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_id, emotion_phrase_verbatim, approval_status, extracted_at)
     VALUES (2, 1000, 1000, 0, 8, 'plain pending row', 'negative', 'low', 0.6,
       'author', 'phrase', 'x', 1, 'thankful', 'pending', '2026-01-02 00:00:00')`
  );
  // Approved row in collection 101 — drives the sentiment-only analytics-subtab test.
  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_id, emotion_phrase_verbatim, approval_status, extracted_at)
     VALUES (3, 1001, 1001, 0, 8, 'sentiment-only collection evidence', 'positive',
       'low', 0.8, 'author', 'phrase', 'something', 1, 'thankful', 'approved',
       '2026-01-03 00:00:00')`
  );
}

describe('Phase 4 polish — review_note notice + drawer bootstrap + collection sentiment subtab', () => {
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

  describe('Polish 1: review_note notice on /admin/knowledge/sentiment/review', () => {
    it('surfaces a flag notice when the pending row carries a Flagged-for-review note', async () => {
      const res = await adminAgent.get('/admin/knowledge/sentiment/review');
      expect(res.status).toBe(200);
      expect(res.text).toContain('sentiment-flag-notice');
      expect(res.text).toContain('Flagged for review from /sentiment: wrong voice role');
    });

    it('does NOT render the notice on pending rows without a Flagged note', async () => {
      const res = await adminAgent.get('/admin/knowledge/sentiment/review');
      // Both pending rows render in the queue, but only the flagged one
      // carries the notice — so the notice should appear exactly once.
      const matches = res.text.match(/sentiment-flag-notice"/g) || [];
      expect(matches.length).toBe(1);
    });
  });

  describe('Polish 2: graph drawer bootstrap', () => {
    it('emits data-viewer-is-admin="1" on the graph-explorer panel for admins', async () => {
      const res = await adminAgent.get('/graph');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/data-graph-explorer[\s\S]*?data-viewer-is-admin="1"/);
    });

    it('omits the admin marker for non-admin viewers (no role bypass)', async () => {
      // The graph page requires auth, so we test via a fresh
      // (non-admin) registered user.
      const userAgent = request.agent(app);
      const reg = await userAgent.get('/register');
      const csrf = extractCsrfToken(reg.text);
      const reqRes = await userAgent
        .post('/register')
        .type('form')
        .send({
          username: 'reader',
          email: 'reader@example.com',
          password: 'readerpass99!',
          confirm: 'readerpass99!',
          _csrf: csrf
        });
      // Registration may require approval; if so, admin-approve it.
      if (reqRes.status === 302 && reqRes.headers.location && reqRes.headers.location.includes('pending')) {
        await db.runAsync(`UPDATE users SET status = 'active' WHERE username = 'reader'`);
        const login = await userAgent.get('/login');
        const lcsrf = extractCsrfToken(login.text);
        await userAgent
          .post('/login')
          .type('form')
          .send({ username: 'reader', password: 'readerpass99!', _csrf: lcsrf });
      }
      const res = await userAgent.get('/graph');
      expect(res.status).toBe(200);
      // Either the attribute is absent, or its value is empty — never "1".
      expect(res.text).not.toMatch(/data-viewer-is-admin="1"/);
    });
  });

  describe('Polish 3: collection-analytics Sentiment subtab', () => {
    it('renders the Sentiment subtab on a collection with sentiment but no BERTopic analytics', async () => {
      const res = await adminAgent.get('/collections/101/analytics');
      expect(res.status).toBe(200);
      // The legacy empty state should NOT appear (we have sentiment to show).
      expect(res.text).not.toMatch(/No analytics have been computed for this collection yet/);
      // Sentiment tab button exists and is the active default since there's no Dashboard/Topics.
      expect(res.text).toMatch(/data-tab="sentiment"[^>]*aria-selected="true"/);
      // Panel renders without the hidden attribute.
      expect(res.text).toMatch(/id="tab-sentiment"(?!\s+hidden)/);
      // Label distribution surfaces the seeded label.
      expect(res.text).toMatch(/s-panel-row-label[^>]*>\s*gratitude/);
    });

    it('shows the legacy empty state for collections with neither analytics nor sentiment', async () => {
      await db.runAsync(`INSERT INTO collections (id, name, is_world_public) VALUES (102, 'Empty', 1)`);
      const res = await adminAgent.get('/collections/102/analytics');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/No analytics have been computed for this collection yet/);
      expect(res.text).not.toMatch(/data-tab="sentiment"/);
    });

    it('the Sentiment-tab "Open in workbench" link uses ?collection=', async () => {
      const res = await adminAgent.get('/collections/101/analytics');
      expect(res.text).toMatch(/href="\/sentiment\?collection=101"/);
    });
  });
});
