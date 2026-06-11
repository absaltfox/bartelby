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
      username: 'etfadmin',
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
    .send({ username: 'etfadmin', password: 'pw-abcdefgh99!', _csrf: loginCsrf });
  expect(loginRes.status).toBe(302);
}, 60_000);

describe('sentiment review entity_type filter (E1.5)', () => {
  let personEntityId, roleEntityId;

  beforeAll(async () => {
    // Insert a document + transcript so foreign keys are satisfied
    await db.runAsync(`INSERT OR IGNORE INTO documents (id, title) VALUES (9901, 'ETF Test Doc')`);
    await db.runAsync(
      `INSERT OR IGNORE INTO transcripts (id, document_id, content) VALUES (9901, 9901, 'test transcript')`
    );

    // Create one person entity and one role entity
    const personResult = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('person', 'Alice ETF Test')`
    );
    personEntityId = personResult.lastInsertRowid;

    const roleResult = await db.runAsync(
      `INSERT INTO entities (entity_type, canonical_name) VALUES ('role', 'Teacher ETF Test')`
    );
    roleEntityId = roleResult.lastInsertRowid;

    // Insert a pending annotation targeting the person entity
    await db.runAsync(
      `INSERT INTO sentiment_annotations
         (transcript_id, document_id, polarity, intensity, confidence, voice_role,
          target_kind, target_entity_id, emotion_phrase_verbatim, evidence_excerpt,
          approval_status, extracted_at)
       VALUES (9901, 9901, 'positive', 'strong', 0.9, 'author',
               'entity', ?, 'admiration', 'She was admirable etf',
               'pending', '2026-01-01T00:00:00.000Z')`,
      [personEntityId]
    );

    // Insert a pending annotation targeting the role entity
    await db.runAsync(
      `INSERT INTO sentiment_annotations
         (transcript_id, document_id, polarity, intensity, confidence, voice_role,
          target_kind, target_entity_id, emotion_phrase_verbatim, evidence_excerpt,
          approval_status, extracted_at)
       VALUES (9901, 9901, 'negative', 'moderate', 0.75, 'speaker',
               'entity', ?, 'resentment', 'Teachers were resented etf',
               'pending', '2026-01-01T00:00:01.000Z')`,
      [roleEntityId]
    );
  });

  it('returns only role-targeted annotations when entity_type=role', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review?entity_type=role')
      .expect(200);

    // Role annotation evidence should appear
    expect(res.text).toContain('Teachers were resented');
    // Person annotation evidence should NOT appear
    expect(res.text).not.toContain('She was admirable etf');
  });

  it('returns only person-targeted annotations when entity_type=person', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review?entity_type=person')
      .expect(200);

    // Person annotation evidence should appear
    expect(res.text).toContain('She was admirable etf');
    // Role annotation evidence should NOT appear
    expect(res.text).not.toContain('Teachers were resented');
  });

  it('returns all pending annotations when entity_type is omitted', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review')
      .expect(200);

    expect(res.text).toContain('Teachers were resented');
    expect(res.text).toContain('She was admirable etf');
  });

  it('ignores invalid entity_type values (treats as no filter)', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review?entity_type=invalid_type')
      .expect(200);

    // Both should appear since filter is ignored
    expect(res.text).toContain('Teachers were resented');
    expect(res.text).toContain('She was admirable etf');
  });

  it('renders entity type dropdown with the selected type pre-selected', async () => {
    const res = await adminAgent
      .get('/admin/knowledge/sentiment/review?entity_type=role')
      .expect(200);

    // The dropdown option for 'role' should be selected
    expect(res.text).toMatch(/value="role"\s+selected/);
    // Other options should not be selected (person option should not have selected)
    expect(res.text).not.toMatch(/value="person"\s+selected/);
  });

  it('returns 200 for all 8 entity types without error', async () => {
    const types = ['person', 'place', 'event', 'organization', 'topic', 'artifact', 'claim', 'role'];
    for (const type of types) {
      await adminAgent
        .get(`/admin/knowledge/sentiment/review?entity_type=${type}`)
        .expect(200);
    }
  });
});
