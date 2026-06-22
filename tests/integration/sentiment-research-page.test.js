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
  await db.runAsync(`INSERT INTO collections (id, name, is_world_public) VALUES (100, 'World Public', 1)`);
  await db.runAsync(`INSERT INTO collections (id, name) VALUES (200, 'Private')`);

  await db.runAsync(`INSERT INTO documents (id, title, date_created, metadata) VALUES (1000, 'Public Letter', '1875-04-15', '{"author":"Alice"}')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (1000, 1000, 'public letter content')`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (1000, 100)`);

  await db.runAsync(`INSERT INTO documents (id, title, date_created) VALUES (2000, 'Private Letter', '1880-09-01')`);
  await db.runAsync(`INSERT INTO transcripts (id, document_id, content) VALUES (2000, 2000, 'private letter')`);
  await db.runAsync(`INSERT INTO document_collections (document_id, collection_id) VALUES (2000, 200)`);

  await db.runAsync(`INSERT INTO sentiment_phrase_labels (id, name) VALUES (1, 'grief')`);
  await db.runAsync(`INSERT INTO sentiment_emotion_phrases (id, phrase_text_normalized, canonical_label_id, usage_count) VALUES (1, 'distressed', 1, 1)`);

  await db.runAsync(
    `INSERT INTO sentiment_annotations
       (id, transcript_id, document_id, span_start, span_end, evidence_excerpt,
        polarity, intensity, confidence, voice_role, target_kind, target_phrase,
        emotion_phrase_id, emotion_phrase_verbatim, notes, approval_status, extracted_at,
        emotion_about_earliest)
     VALUES
       (1, 1000, 1000, 12, 22, 'deeply distressed by the news', 'negative', 'strong', 0.9, 'author', 'phrase', 'the news',
        1, 'deeply distressed', 'Direct grief about an event.', 'approved', '2026-01-01 00:00:00', null),
       (2, 2000, 2000, 0, 5, 'private evidence', 'negative', 'moderate', 0.8, 'author', 'phrase', 'school',
        1, 'distressed', null, 'approved', '2026-01-02 00:00:00', null),
       (3, 1000, 1000, 30, 40, 'pending evidence', 'negative', 'low', 0.6, 'author', 'phrase', 'school',
        1, 'distressed', null, 'pending', '2026-01-03 00:00:00', null)`
  );
}

describe('GET /sentiment (HTML page)', () => {
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

  it('anonymous: renders the page with only world_public annotations', async () => {
    const res = await request(app).get('/sentiment');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Sentiment Research');
    // Public evidence appears; private does not.
    expect(res.text).toContain('deeply distressed by the news');
    expect(res.text).not.toContain('private evidence');
    // Pending row never visible to anonymous.
    expect(res.text).not.toContain('pending evidence');
  });

  it('anonymous: bootstrap data exposes filters + isAdmin=false', async () => {
    const res = await request(app).get('/sentiment');
    const match = res.text.match(/window\.__sentimentResearchData\s*=\s*(\{[^<]+?\});/);
    expect(match).toBeTruthy();
    const data = JSON.parse(match[1]);
    expect(data.isAdmin).toBe(false);
    expect(data.filters.status).toBe('approved');
  });

  it('admin: page includes the admin-only status filter block', async () => {
    const res = await adminAgent.get('/sentiment');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Approval status/);
    expect(res.text).toMatch(/s-filter-admin-tag/);
    // Admin can see private collection's evidence too.
    expect(res.text).toContain('private evidence');
  });

  it('admin: paradata block is rendered as collapsed for cards that have it', async () => {
    const res = await adminAgent.get('/sentiment');
    expect(res.text).toMatch(/data-sentiment-paradata-toggle/);
    expect(res.text).toContain('Direct grief about an event.');
  });

  it('label distribution panel renders with the seeded label', async () => {
    const res = await request(app).get('/sentiment');
    expect(res.text).toMatch(/Label distribution/);
    expect(res.text).toMatch(/s-panel-row-label[^>]*>\s*grief/);
  });

  it('renders mode bar with list active and timeline hidden', async () => {
    const res = await request(app).get('/sentiment');
    // List button has both the active class and the list mode marker.
    expect(res.text).toMatch(/s-research-mode--active[\s\S]*?data-sentiment-mode="list"/);
    expect(res.text).toMatch(/id="s-research-timeline-panel"[^>]*hidden/);
  });

  it('serves the page-specific script and the shared filter sidebar script', async () => {
    const res = await request(app).get('/sentiment');
    expect(res.text).toContain('/js/filter-sidebar.js');
    expect(res.text).toContain('/js/sentiment-research.js');
  });

  it('400-handling: plutchik filter renders an error banner instead of crashing', async () => {
    const res = await request(app).get('/sentiment?plutchik=joy');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/s-research-banner--error/);
    expect(res.text).toMatch(/plutchik/i);
  });
});
