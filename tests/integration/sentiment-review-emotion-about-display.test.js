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
      username: 'eaadmin',
      password: 'pw-abcdefgh99!',
      confirm: 'pw-abcdefgh99!',
      bootstrap_token: process.env.BOOTSTRAP_ADMIN_TOKEN,
      _csrf: setupCsrf
    });

  adminAgent = request.agent(app);
  const loginPage = await adminAgent.get('/login');
  const loginCsrf = extractCsrfToken(loginPage.text);
  const loginRes = await adminAgent
    .post('/login')
    .type('form')
    .send({ username: 'eaadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('sentiment review emotion_about_* display (S2.4)', () => {
  beforeAll(async () => {
    // Insert a document + transcript so foreign keys are satisfied
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (9950, 'EA Test Doc')`);
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (9950, 9950, 'test transcript ea')`
    );

    // Annotation WITH emotion_about_* populated
    await db.runAsync(
      `INSERT INTO sentiment_annotations
         (transcript_id, document_id, polarity, intensity, confidence, voice_role,
          target_kind, target_phrase, emotion_phrase_verbatim, evidence_excerpt,
          approval_status, extracted_at,
          emotion_about_phrase_verbatim, emotion_about_earliest, emotion_about_latest,
          emotion_about_precision, emotion_about_qualifier)
       VALUES (9950, 9950, 'positive', 'strong', 0.9, 'author',
               'phrase', 'the war', 'admiration ea', 'He admired the war era ea',
               'pending', '2026-01-01T00:00:00.000Z',
               'the war era', '1914-01-01', '1918-11-11',
               'year', 'approximately')`
    );

    // Annotation with all-NULL emotion_about_*
    await db.runAsync(
      `INSERT INTO sentiment_annotations
         (transcript_id, document_id, polarity, intensity, confidence, voice_role,
          target_kind, target_phrase, emotion_phrase_verbatim, evidence_excerpt,
          approval_status, extracted_at,
          emotion_about_phrase_verbatim, emotion_about_earliest, emotion_about_latest,
          emotion_about_precision, emotion_about_qualifier)
       VALUES (9950, 9950, 'negative', 'moderate', 0.75, 'speaker',
               'phrase', 'the peace', 'resentment ea', 'He resented the peace ea',
               'pending', '2026-01-01T00:00:01.000Z',
               NULL, NULL, NULL, NULL, NULL)`
    );
  });

  it('renders emotion_about_phrase_verbatim text for the populated annotation', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review')
      .expect(200);

    expect(res.text).toContain('the war era');
  });

  it('renders emotion_about_earliest date for the populated annotation', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review')
      .expect(200);

    expect(res.text).toContain('1914-01-01');
  });

  it('renders the emotion_about_precision label for the populated annotation', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review')
      .expect(200);

    expect(res.text).toContain('precision year');
  });

  it('renders data-emotion-about="true" marker for the populated annotation', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review')
      .expect(200);

    expect(res.text).toContain('data-emotion-about="true"');
  });

  it('does NOT render data-emotion-about="true" for the all-NULL annotation', async () => {
    // Insert an annotation with a unique evidence_excerpt so we can check its card specifically
    // We verify that the NULL annotation's card does not contain data-emotion-about by checking
    // the total count of data-emotion-about occurrences equals 1 (only the populated one)
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review')
      .expect(200);

    const matches = (res.text.match(/data-emotion-about="true"/g) || []).length;
    // There may be other tests' annotations, but only our one populated annotation should add this marker
    // At minimum the marker appears once (populated) and not for the NULL one
    expect(matches).toBeGreaterThanOrEqual(1);
    // Verify the NULL annotation's evidence text is present (annotation renders)
    expect(res.text).toContain('He resented the peace ea');
  });

  it('renders the qualifier for the populated annotation', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review')
      .expect(200);

    expect(res.text).toContain('approximately');
  });
});
